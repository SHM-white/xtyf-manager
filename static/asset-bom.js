/* Spreadsheet preview only; a separate, confirmed JSON write updates inventory. */
(() => {
  'use strict';
  const core=window.AssetLedger, $=id=>document.getElementById(id), esc=core.esc;
  const dialog=$('asset-bom-dialog'), form=$('asset-bom-form'), rowsHost=$('asset-bom-rows');
  const upload=$('asset-bom-file'), campus=$('asset-bom-campus'), mode=$('asset-bom-mode');
  const sets=$('asset-bom-sets'), summary=$('asset-bom-summary'), message=$('asset-bom-message');
  const save=$('asset-bom-save');
  if(!dialog||!core)return;
  let previewRows=[],canManage=false,file=null,loadedMode='',loadedCampus='',pendingBatch=null,busy=false;
  const key='xtyf.assets.unconfirmed.v1:'+(window.XTYF?.config?.serverUrl||location.origin);
  const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
  const show=(text,alert=false)=>{message.textContent=text;message.dataset.state=alert?'error':'info';};
  const quantity=row=>row.quantity*(mode.value==='outbound'?Number(sets.value):1);
  function reset(messageText='请选择表格并点击“解析并匹配”。'){
    previewRows=[];rowsHost.replaceChildren();save.disabled=true;
    summary.textContent='';show(messageText);
  }
  function matchOf(r){return r.candidates.find(i=>String(i.id)===String(r.selected));}
  function allRows(){
    const grouped=new Map(),problems=[];
    for(const r of previewRows){
      const qty=quantity(r);
      if(!Number.isSafeInteger(qty)||qty<1||qty>1000000000){problems.push('第 '+r.row_no+' 行的数量超限');continue;}
      if(r.selected==='new'){
        if(mode.value!=='inbound'||!canManage||!r.name){problems.push('第 '+r.row_no+' 行不能新建物料');}
        continue;
      }
      const item=matchOf(r);
      if(!item){problems.push('第 '+r.row_no+' 行尚未匹配');continue;}
      if(!item.active||['unit','migrating','status'].includes(item.tracking)){
        problems.push('M:'+item.id+' 需要单件或状态操作');continue;
      }
      const total=grouped.get(item.id)||{qty:0,available:item.available,name:item.name};
      total.qty+=qty;grouped.set(item.id,total);
    }
    if(mode.value==='outbound')for(const [id,value] of grouped){
      if(value.qty>value.available)problems.push('M:'+id+' 库存不足：需要 '+value.qty+'，现有 '+value.available);
    }
    return {grouped,problems};
  }
  function summaryRefresh(){
    const {grouped,problems}=allRows();
    const count=Array.from(grouped.values()).reduce((n,r)=>n+r.qty,0);
    const newCount=previewRows.filter(r=>r.selected==='new').length;
    summary.textContent=previewRows.length?
      '共 '+previewRows.length+' 行，已关联 '+grouped.size+' 种库存物料，合计 '+count+
      ' 件'+(newCount?'；待新建 '+newCount+' 种':'')+
      (mode.value==='outbound'?'，按 '+sets.value+' 套计算。':'，按表格实收数量入库。'):'';
    if(problems.length)show('无法提交：'+problems.slice(0,4).join('；')+(problems.length>4?'；另有 '+(problems.length-4)+' 项':'')+'。',true);
    else if(previewRows.length)show('匹配完成。请逐行确认型号、库存与操作数量后提交。');
    save.disabled=busy||!previewRows.length||!!problems.length||core.blocked;
  }
  function render(){
    rowsHost.replaceChildren();
    if(!previewRows.length)return;
    const table=document.createElement('table');table.className='asset-bom-table';
    const head=document.createElement('thead');
    head.innerHTML='<tr><th>行号</th><th>表格物料</th><th>单套／入库数</th><th>库存匹配（可手动选择）</th><th>操作数量／结果</th></tr>';
    table.append(head);
    const body=document.createElement('tbody');
    for(const [index,r] of previewRows.entries()){
      const tr=document.createElement('tr');
      const rowNumber=document.createElement('td');rowNumber.textContent=r.row_no;
      const identity=document.createElement('td');
      const strong=document.createElement('strong');strong.textContent=r.name||r.code||'未命名';
      identity.append(strong);
      const meta=document.createElement('small');meta.textContent=[r.code,r.specification,r.unit].filter(Boolean).join(' · ');
      identity.append(meta);
      const q=document.createElement('td');q.textContent=r.quantity;
      const choose=document.createElement('td');
      const select=document.createElement('select');select.dataset.index=index;select.setAttribute('aria-label','第 '+r.row_no+' 行匹配物料');
      const options=[['','请选择库存物料'],...r.candidates.map(c=>[String(c.id),'M:'+c.id+' · '+c.name+(c.specification?' / '+c.specification:'')])];
      if(mode.value==='inbound'&&canManage&&r.name)options.push(['new','＋ 作为新数量耗材建档']);
      for(const [value,label] of options){const opt=document.createElement('option');opt.value=value;opt.textContent=label;select.append(opt);}
      select.value=r.selected||'';
      select.addEventListener('change',()=>{r.selected=select.value;render();});
      choose.append(select);
      const manual=document.createElement('div');manual.className='asset-bom-manual';
      const input=document.createElement('input');input.type='number';input.min=1;input.placeholder='物料 ID';input.setAttribute('aria-label','输入已有物料 ID');
      const find=document.createElement('button');find.type='button';find.className='btn';find.textContent='指定 ID';
      find.addEventListener('click',async()=>{
        const id=Number(input.value);
        if(!Number.isSafeInteger(id)||id<1){show('请输入有效的物料 ID（M: 后面的数字）。',true);return;}
        find.disabled=true;
        try{
          const data=await core.api('items/'+id);
          const c=data.campuses.find(v=>v.id===Number(campus.value));
          const candidate={...data.item,available:c?.available||0,stock_version:c?.stock_version||0};
          if(!r.candidates.some(x=>x.id===id))r.candidates.push(candidate);
          r.selected=String(id);render();
        }catch(error){show(error.message,true);}finally{find.disabled=false;}
      });
      manual.append(input,find);choose.append(manual);
      const result=document.createElement('td');
      const matched=matchOf(r);
      result.textContent=r.selected==='new'?'新建耗材并入库 '+r.quantity+' '+r.unit:
        matched?'在库 '+matched.available+' → '+(mode.value==='outbound'?matched.available-quantity(r):matched.available+quantity(r))+
          '；本行 '+(mode.value==='outbound'?'出库 ':'入库 ')+quantity(r):
        r.candidates.length>1?'多个候选，请核对':'未找到唯一匹配';
      if(matched&&['unit','migrating','status'].includes(matched.tracking))
        result.textContent='不支持数量批量操作（'+matched.tracking+'）';
      tr.append(rowNumber,identity,q,choose,result);body.append(tr);
    }
    table.append(body);rowsHost.append(table);summaryRefresh();
  }
  function configure(){
    const c=core.catalog;if(!c)return;
    const old=campus.value;
    campus.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择校区';
    campus.append(placeholder);
    for(const x of c.campuses.filter(x=>x.active)){const opt=document.createElement('option');opt.value=x.id;opt.textContent=x.name;campus.append(opt);}
    if([...campus.options].some(x=>x.value===old))campus.value=old;
    else if(campus.options.length===2)campus.selectedIndex=1;
    $('asset-bom-open').hidden=new URLSearchParams(location.search).has('id')||new URLSearchParams(location.search).get('view')==='mine';
    canManage=c.can_manage;
  }
  async function parse(){
    file=upload.files[0]||file;
    if(!file){show('先选择 CSV、TSV 或 XLSX 文件。',true);return;}
    if(!campus.value){show('请先选择校区。',true);return;}
    if(file.size>2*1024*1024){show('文件超过 2 MiB，请拆分。',true);return;}
    const data=new FormData();
    data.append('file',file);data.append('campus_id',campus.value);data.append('mode',mode.value);
    busy=true;save.disabled=true;show('正在解析表格并匹配已有物料…');
    try{
      const response=await fetch('/api/assets/bom/preview',{method:'POST',body:data});
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'表格解析失败');
      previewRows=data.rows.map(r=>({...r,selected:r.candidates.length===1?String(r.candidates[0].id):''}));
      canManage=data.can_manage;loadedMode=mode.value;loadedCampus=campus.value;
      render();
    }catch(error){reset();show(error.message,true);}
    finally{busy=false;summaryRefresh();}
  }
  $('asset-bom-open').addEventListener('click',()=>{
    if(core.blocked){show('存在尚未确认的库存登记，请先处理后再批量操作。',true);return;}
    configure();core.showDialog(dialog);
  });
  $('asset-bom-close').addEventListener('click',()=>{if(!busy&&!pendingBatch)dialog.close();});
  $('asset-bom-preview').addEventListener('click',parse);
  upload.addEventListener('change',()=>{file=upload.files[0];reset();});
  for(const el of [campus,mode])el.addEventListener('change',()=>{if(previewRows.length)reset('校区或操作方式已改变，请重新解析表格。');});
  sets.addEventListener('input',()=>{sets.value=sets.value;summaryRefresh();});
  mode.addEventListener('change',()=>{$('asset-bom-sets-label').hidden=mode.value!=='outbound';});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(busy||core.blocked)return;
    const {problems}=allRows();
    if(problems.length){summaryRefresh();return;}
    if(loadedMode!==mode.value||loadedCampus!==campus.value){show('校区或操作方式已变化，请重新解析。',true);return;}
    const body={mode:mode.value,campus_id:Number(campus.value),sets:mode.value==='outbound'?Number(sets.value):1,
      reason:form.elements.reason.value.trim(),
      rows:previewRows.map(r=>{
        const item=matchOf(r);
        return r.selected==='new'?{item_id:null,quantity:r.quantity,name:r.name,
          specification:r.specification,unit:r.unit,code:r.code}:
          {item_id:item.id,version:item.version,stock_version:item.stock_version,quantity:r.quantity};
      })};
    if(!body.reason){show('请填写用途或入库原因。',true);return;}
    if(!pendingBatch){
      const actor=core.catalog?.member_id;
      if(!actor){show('账号状态无效，请刷新后重试',true);return;}
      if(sessionStorage.getItem(key)){show('有尚未确认的资产操作，请先处理。',true);return;}
      pendingBatch={actor_id:actor,path:'bom/commit',body,request_id:token()};
      try{sessionStorage.setItem(key,JSON.stringify(pendingBatch));}
      catch(_){pendingBatch=null;show('无法保存幂等重试信息，本次未提交。',true);return;}
    }
    busy=true;save.disabled=true;$('asset-bom-close').disabled=true;
    try{
      const result=await core.api(pendingBatch.path,{...pendingBatch.body,request_id:pendingBatch.request_id});
      sessionStorage.removeItem(key);pendingBatch=null;
      reset('已完成 '+result.operations.length+' 种物料的批量登记。');
      form.reset();file=null;
      await core.load();show('提交成功，已写入库存及流转记录。');
    }catch(error){
      if(error.businessRejected){sessionStorage.removeItem(key);pendingBatch=null;show(error.message+'；本次未写入，请重新预览。',true);}
      else {show('请求结果尚未确认：'+error.message+'。请点击“确认提交／重试”重发同一请求，勿重复新建批次。',true);save.disabled=false;}
    }finally{busy=false;$('asset-bom-close').disabled=!!pendingBatch;if(pendingBatch)save.disabled=false;}
  });
  document.addEventListener('assets-loaded',configure);
  if(core.catalog)configure();
})();
