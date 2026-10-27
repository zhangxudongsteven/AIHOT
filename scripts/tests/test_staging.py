"""Validate isolation against actual Compose rendering without starting containers."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('staging', ROOT / 'scripts/deploy-staging.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)

class Isolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['docker', 'compose', '-p', 'myhot-staging', '--profile', 'tools',
            '--env-file', str(ROOT / 'deploy/staging.env.example'), '-f', str(ROOT / 'compose.lan.yml'),
            '-f', str(ROOT / 'compose.staging.yml'), 'config', '--format', 'json'],
            capture_output=True, text=True, env={**staging.os.environ,
                'PGPASSWORD': 'fixture-only', 'ADMIN_PASSWORD': 'fixture-admin-password',
                'SESSION_SECRET': 's' * 32, 'IMG_PROXY_SIGN_SECRET': 'i' * 32,
                'AIHOT_RELEASE': 'fixture', 'DATABASE_URL': 'postgres://myhot_staging@172.16.0.17:5432/myhot_staging',
                'SITE_URL': 'http://localhost:3200'})
        if result.returncode:
            raise RuntimeError('Compose fixture rendering failed')
        cls.config = json.loads(result.stdout)

    def test_valid_rendered_configuration(self):
        staging.validate(self.config)

    def test_rejects_running_database_and_credentials(self):
        for url in ('postgres://myhot@172.16.0.17/myhot',
                    'postgres://myhot_staging@172.16.0.17/myhot',
                    'postgres://myhot_staging@172.16.0.17/myhot_staging?user=myhot'):
            config = copy.deepcopy(self.config)
            config['services']['setup']['environment']['DATABASE_URL'] = url
            with self.assertRaises(ValueError): staging.validate(config)

    def test_rejects_shared_storage_network_port_and_external_actions(self):
        cases = [
            lambda c: c['volumes']['data'].update(name='myhot-lan_data'),
            lambda c: c['networks']['default'].update(name='myhot-lan_default'),
            lambda c: c['services']['web']['ports'][0].update(host_ip='0.0.0.0'),
            lambda c: c['services']['worker']['environment'].update(MODEL_CALLS_ENABLED='true'),
            lambda c: c['services']['web']['environment'].update(PGPASSWORD='fixture'),
            lambda c: c['services']['api'].update(image='myhot-lan-app:old'),
        ]
        for mutate in cases:
            config = copy.deepcopy(self.config)
            mutate(config)
            with self.assertRaises(ValueError): staging.validate(config)

if __name__ == '__main__': unittest.main()
