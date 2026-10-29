"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function fixture() {
  const root = path.resolve(__dirname, "../..");
  const context = {
    BusinessUI: { escape: (value) => String(value ?? "").replace(/[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]) },
    console, setInterval() {}, setTimeout() {}, document: { addEventListener() {} },
    location: { href: "" }, FormData: class FormData {},
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["app.js", "task-board.js", "task-tree.js", "task-timeline.js", "dashboard.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "static", file), "utf8"), context, {filename:file});
  }
  const get = (expression) => vm.runInContext(expression, context);
  const state = get("state");
  state.me = {id:1, role:"member"};
  state.members = [{id:1,name:"负责人"}];
  return {get};
}
const task = (fields = {}) => ({
  id: 42, title: "测试任务", status:"进行中", days_left:10, priority:"中",
  progress:45, owner_id:1, participant_ids:[], due_date:"2026-11-07",
  start_date:"2026-10-29", updated_at:"今天", ...fields,
});

test("one visual precedence, with deadline flags retained for combined exceptional states", () => {
  const {get} = fixture();
  const tone = get("taskHighlightTone"), classes = get("taskHighlightClasses");
  const cases = [
    [{status:"阻塞",days_left:-2,dependency_warnings:["缺失前置"]}, "blocked", ["is-blocked","overdue","has-warning"], ["is-due-soon"]],
    [{status:"阻塞",days_left:1}, "blocked", ["is-blocked","is-due-soon"], ["overdue"]],
    [{days_left:-1}, "overdue", ["overdue"], ["is-due-soon"]],
    [{days_left:0}, "due-soon", ["is-due-soon"], ["overdue"]],
    [{days_left:3}, "due-soon", ["is-due-soon"], ["overdue"]],
    [{days_left:4,dependency_warnings:["检查依赖"]}, "dependency", ["has-warning"], ["overdue"]],
    [{days_left:4}, "in-progress", [], ["is-due-soon"]],
    [{status:"未开始",days_left:4}, "not-started", [], ["is-blocked"]],
    [{status:"已完成",days_left:-3,dependency_warnings:["过期提示"]}, "completed", [], ["overdue","has-warning"]],
    [{status:"已取消",days_left:0}, "cancelled", [], ["is-due-soon"]],
  ];
  for (const [fields, expected, present, absent] of cases) {
    const sample = task(fields);
    assert.equal(tone(sample),expected);
    const names = classes(sample).split(/\s+/);
    assert.ok(names.includes("task-tone-"+expected));
    for(const name of present) assert.ok(names.includes(name),name+" missing");
    for(const name of absent) assert.ok(!names.includes(name),name+" should not appear");
  }
});

test("board, dashboard, dependency graph and timeline share the same signal", () => {
  const {get} = fixture();
  for(const fields of [{status:"阻塞",days_left:-3}, {days_left:2},
    {days_left:-1}, {status:"已完成",days_left:-8}, {status:"未开始",days_left:null}]) {
    const item = task(fields);
    const tone = get("taskHighlightTone")(item);
    const rendered = [
      get("taskCard")(item),
      get("treeTaskCard")(item),
      get("timelineTaskRow")(item,{start:1,end:20}),
      get("dashboardTaskRow")(item),
    ];
    for(const html of rendered) {
      assert.ok(html.includes("task-tone-"+tone),tone+" missing in "+html.slice(0,90));
      if(fields.status==="阻塞") {
        assert.match(html,/is-blocked/);
        assert.match(html,/逾期/);
      }
    }
  }
});

test("day-zero, finished and dependency labels stay readable without relying on color", () => {
  const {get} = fixture();
  const label = get("taskAttentionBadge");
  assert.match(label(task({days_left:0}),true),/今日/);
  assert.match(label(task({days_left:3}),true),/临期/);
  assert.match(label(task({days_left:-4}),false),/已逾期 4 天/);
  assert.match(label(task({days_left:20,dependency_warnings:["检查依赖"]})),/依赖提醒/);
  assert.equal(label(task({status:"已完成",days_left:-2})), "");
  assert.equal(label(task({status:"已取消",days_left:0})), "");
});
