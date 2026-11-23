"""Exercise ledger and invoice synchronization through their normal APIs."""
from io import BytesIO
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from test_tasks import app_module
from modules import invoices


class TestPersonalReimbursement(unittest.TestCase):
    def setUp(self):
        self.admin = self.login('admin', 'ci-test-password-only')
        self.reviewer, self.reviewer_id = self.member('审核测试', role='manager')
        grant = self.admin.post(f'/api/admin/permissions/{self.reviewer_id}', json={
            'permissions': ['funds.review', 'invoices.manage'],
        })
        self.assertEqual(grant.status_code, 200)
        designation = patch.dict(os.environ, {'FUNDS_PERSONAL_REVIEWER_ID': str(self.reviewer_id)})
        designation.start()
        self.addCleanup(designation.stop)
        self.applicant, self.applicant_id = self.member('同名申请人')
        self.other, self.other_id = self.member('同名申请人')

    def login(self, username, password):
        client = app_module.app.test_client()
        self.assertTrue(client.post('/login', json={'username': username, 'password': password}).get_json()['ok'])
        return client

    def member(self, display_name, role='member'):
        username, password = 'finance_' + uuid4().hex[:12], 'finance-test-password'
        created = self.admin.post('/api/member', json={
            'name': display_name, 'username': username, 'password': password, 'role': role,
        }).get_json()
        self.assertTrue(created['ok'], created)
        return self.login(username, password), created['id']

    def expense(self, amount):
        response = self.applicant.post('/funds/api/records', json={
            'request_id': uuid4().hex, 'record_type': '出', 'self_funded': True,
            'amount': amount, 'source_dest': '购买测试材料', 'record_date': '2026-11-23',
            'applicant_id': self.other_id, 'applicant': '其他人', 'invoice_count': 0,
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def invoice(self, owner, amount, status='未报销'):
        token = uuid4().hex
        upload = self.admin.post('/invoices/api/upload', data={
            'file': (BytesIO(b'%PDF-1.4\n% ' + token.encode() + b'\n%%EOF'), 'test.pdf'),
        }).get_json()
        response = self.admin.post('/invoices/api/upload/confirm', json={
            'tmp_path': upload['tmp_path'], 'month': '2026.11', 'date': '2026-11-23',
            'amount': amount, 'submitter_id': owner, 'status': status, 'invoice_number': token[:16],
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()['rel_path']

    def test_member_application_review_payment_and_invoice_move(self):
        amount = '61799.27'
        baseline = self.other.get('/funds/api/stats').get_json()['data']
        created = self.expense(amount)
        record_url = f"/funds/api/records/{created['id']}"
        pending = self.other.get(record_url).get_json()['data']
        self.assertEqual(pending['applicant_id'], self.applicant_id)
        self.assertEqual(pending['applicant'], '同名申请人')
        self.assertEqual(pending['personal_status'], '未个人报销')
        self.assertEqual(pending['review_status'], '待审核')
        self.assertEqual(self.applicant.put(record_url, json={'version': 1, 'amount': '1.00'}).status_code, 403)

        initial_stats = self.other.get('/funds/api/stats').get_json()['data']
        self.assertEqual(initial_stats['balance'], baseline['balance'])
        self.assertEqual(int(initial_stats['unapproved_out_cents']) - int(baseline['unapproved_out_cents']), 6179927)
        self.assertEqual(initial_stats['record_count'], baseline['record_count'] + 1)

        selected = self.invoice(self.applicant_id, amount)
        second = self.invoice(self.applicant_id, amount, '已报销')
        unrelated = self.invoice(self.other_id, amount)
        self.invoice(self.reviewer_id, '71.02')
        before = self.applicant.get('/invoices/api/stats?scope=mine').get_json()
        self.assertEqual(before['status_stats']['未个人报销']['count'], 2)
        self.assertEqual(before['status_stats']['已个人报销']['count'], 0)
        self.assertEqual(self.reviewer.get('/invoices/api/stats?scope=mine').get_json()['total_count'], 1)

        self.assertIn('id="refreshPersonalInvoices"', self.reviewer.get('/funds/').get_data(as_text=True))
        for client in (self.admin, self.other):
            self.assertNotIn('id="refreshPersonalInvoices"', client.get('/funds/').get_data(as_text=True))
            self.assertEqual(client.get('/funds/api/personal-invoices').status_code, 403)
            self.assertEqual(client.post(record_url+'/review', json={'version': 1}).status_code, 403)
            self.assertEqual(client.post(record_url+'/personal-reimbursement', json={'version': 1}).status_code, 403)

        with patch.object(invoices, 'scan_invoices', side_effect=AssertionError('lookup should use the catalog')):
            lookup = self.reviewer.get('/funds/api/personal-invoices').get_json()
        self.assertEqual({item['id'] for item in lookup['matches']['6179927']}, {selected, second, unrelated})
        payment = {'invoice_id': selected, 'generation': lookup['generation'], 'version': 1}
        self.assertEqual(self.reviewer.post(record_url+'/personal-reimbursement', json=payment).status_code, 409)
        approved = self.reviewer.post(record_url+'/review', json={'version': 1})
        self.assertEqual(approved.status_code, 200, approved.get_json())
        payment['version'] = approved.get_json()['version']
        approved_stats = self.other.get('/funds/api/stats').get_json()['data']
        self.assertEqual(int(baseline['balance_cents']) - int(approved_stats['balance_cents']), 6179927)
        self.assertEqual(approved_stats['unapproved_out'], baseline['unapproved_out'])
        self.assertEqual(self.reviewer.post(record_url+'/personal-reimbursement', json={
            **payment, 'invoice_id': unrelated,
        }).status_code, 409)
        self.assertEqual(self.reviewer.post(record_url+'/personal-reimbursement', json={
            **payment, 'generation': 'stale',
        }).status_code, 409)

        paid = self.reviewer.post(record_url+'/personal-reimbursement', json=payment)
        self.assertEqual(paid.status_code, 200, paid.get_json())
        self.assertEqual(self.other.get(record_url).get_json()['data']['personal_status'], '已个人报销')
        self.assertEqual(self.admin.delete(record_url, query_string={'version': paid.get_json()['version']}).status_code, 409)
        self.assertEqual(self.reviewer.post(record_url+'/personal-reimbursement', json=payment).status_code, 409)
        another = self.expense(amount)['id']
        self.assertEqual(self.reviewer.post(f'/funds/api/records/{another}/review', json={'version': 1}).status_code, 200)
        self.assertEqual(self.reviewer.post(f'/funds/api/records/{another}/personal-reimbursement',
                                            json=payment).status_code, 409)

        move = self.admin.post('/invoices/api/invoice/update', json={'id': selected, 'status': '正在报销'}).get_json()
        self.assertTrue(move['moved'], move)
        self.assertEqual(self.admin.post('/invoices/api/invoice/update', json={
            'id': move['id'], 'submitter_id': self.other_id,
        }).status_code, 409)
        filter_args = {'scope': 'mine', 'status': '已个人报销'}
        mine = self.applicant.get('/invoices/api/invoices', query_string=filter_args).get_json()['data']
        self.assertEqual([(invoice['id'], invoice['status']) for invoice in mine], [(move['id'], '已个人报销')])
        self.assertNotIn('personal_invoice_key', mine[0])
        after = self.applicant.get('/invoices/api/stats?scope=mine').get_json()
        self.assertEqual(after['status_stats']['已个人报销']['count'], 1)
        all_invoices = self.admin.get('/invoices/api/invoices', query_string={'id': move['id']}).get_json()['data']
        self.assertEqual(all_invoices[0]['status'], '正在报销')
        self.assertEqual(self.other.get('/invoices/api/invoices', query_string=filter_args).get_json()['total'], 0)


if __name__ == '__main__':
    unittest.main()
