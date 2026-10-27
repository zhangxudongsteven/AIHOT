#!/usr/bin/env python3
"""Manage only the isolated local staging project; never load the running env file."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
FLAGS = ('COLLECT_ENABLED', 'MODEL_CALLS_ENABLED', 'FEISHU_CONTENT_PUSH_ENABLED',
         'FEISHU_INTERNAL_ENABLED', 'INDEXNOW_SUBMIT_ENABLED')


def validate(config):
    if config['name'] != 'myhot-staging':
        raise ValueError('Unexpected Compose project')
    for name in ('setup', 'api', 'worker', 'web'):
        service = config['services'][name]
        if not service['image'].startswith('myhot-staging-app:'):
            raise ValueError('Staging requires its own image tag')
        env = service['environment']
        if env['SITE_URL'] != 'http://localhost:3200':
            raise ValueError('Staging SITE_URL must be http://localhost:3200')
        if name != 'web':
            connection = urlparse(env['DATABASE_URL'])
            if (connection.scheme not in ('postgres', 'postgresql') or
                    connection.username != 'myhot_staging' or
                    connection.path != '/myhot_staging' or connection.password or
                    connection.query or connection.fragment):
                raise ValueError('Staging requires the dedicated database and account')
            if any(env.get(flag) != 'false' for flag in FLAGS):
                raise ValueError('Staging external actions must remain disabled')
            if any(key.endswith(('_API_KEY', '_WEBHOOK_URL')) and value for key, value in env.items()):
                raise ValueError('Staging must not receive external service credentials')
            if len(env.get('ADMIN_PASSWORD', '')) < 12 or any(
                    len(env.get(key, '')) < 32 for key in ('SESSION_SECRET', 'IMG_PROXY_SIGN_SECRET')):
                raise ValueError('Independent staging administrator and signing secrets are required')
        elif any(key in env for key in ('DATABASE_URL', 'PGPASSWORD', 'SESSION_SECRET', 'ADMIN_PASSWORD')):
            raise ValueError('Web must not receive backend credentials')
        for mount in service.get('volumes', []):
            if mount['type'] != 'volume' or mount['source'] != 'data':
                raise ValueError('Unexpected staging mount')
        ports = service.get('ports', [])
        if name == 'web':
            if len(ports) != 1 or ports[0].get('host_ip') != '127.0.0.1' or str(ports[0]['published']) != '3200':
                raise ValueError('Staging may publish only loopback port 3200')
        elif ports:
            raise ValueError('Backend ports must remain private')
    if config['volumes']['data'].get('name') != 'myhot-staging_data' or config['volumes']['data'].get('external'):
        raise ValueError('Unexpected staging data volume')
    if config['networks']['default'].get('name') != 'myhot-staging_default' or config['networks']['default'].get('external'):
        raise ValueError('Unexpected staging network')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'build', 'deploy', 'verify', 'status', 'stop', 'logs'))
    args = parser.parse_args()
    env_file = ROOT / '.data/staging/deploy.env'
    if env_file.is_symlink() or not env_file.is_file() or env_file.stat().st_mode & 0o077:
        raise ValueError('Create private .data/staging/deploy.env with mode 0600')
    # Use only the selected file for interpolation, including when shell overrides exist.
    compose_env = {key: value for key, value in os.environ.items() if key in (
        'PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
        'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'TMPDIR')}
    command = ['docker', 'compose', '--project-directory', str(ROOT), '--project-name', 'myhot-staging',
               '--profile', 'tools', '--env-file', str(env_file), '-f', str(ROOT / 'compose.lan.yml'), '-f', str(ROOT / 'compose.staging.yml')]

    def run(*extra, capture=False):
        result = subprocess.run(command + list(extra), env=compose_env, text=True,
                                capture_output=capture, check=False)
        if result.returncode:
            raise ValueError('Staging Compose command failed' if capture else 'Staging action failed; inspect status and logs')
        return result.stdout

    validate(json.loads(run('config', '--format', 'json', capture=True)))
    if args.action == 'check':
        subprocess.run(['docker', 'info'], env=compose_env, stdout=subprocess.DEVNULL, check=True)
        print('Staging configuration and Docker access passed')
    elif args.action == 'build':
        run('build', 'setup')
    elif args.action == 'deploy':
        run('run', '--rm', '--no-deps', '-T', 'setup', 'node', '--input-type=module', '-e',
            "import {sql,closeDb} from '@aihot/backend/db'; "
            "try { const [r]=await sql`SELECT current_database() AS db,current_user AS usr,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`; "
            "if(r.db!=='myhot_staging'||r.usr!=='myhot_staging'||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolbypassrls) throw new Error('Staging database identity or privileges rejected'); "
            "console.log('Staging database identity passed'); } finally {await closeDb();}")
        # Intentionally no build or running-environment operation. Back up staging before reusing it.
        run('stop', 'api', 'worker', 'web')
        run('run', '--rm', '--no-deps', '-T', 'setup')
        run('up', '-d', '--no-build', '--wait', '--wait-timeout', '240', 'api', 'worker', 'web')
        run('exec', '-T', 'web', 'node', 'scripts/smoke.ts', '--base', 'http://127.0.0.1:3000')
    elif args.action == 'verify':
        run('exec', '-T', 'web', 'node', 'scripts/smoke.ts', '--base', 'http://127.0.0.1:3000')
    elif args.action == 'status':
        run('ps', '--all')
    elif args.action == 'stop':
        run('stop', 'api', 'worker', 'web')
    else:
        run('logs', '--tail', '100', 'api', 'worker', 'web')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
