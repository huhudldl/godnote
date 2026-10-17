#!/usr/bin/env python3
# 갓 노트 아이패드 홈 화면 아이콘(웹 클립 프로파일) 만들기
#   python3 build.py                 → build/갓 노트.mobileconfig (깃허브 페이지 주소)
#   python3 build.py http://주소:포트/  → 다른 주소로 여는 아이콘
import plistlib, sys, uuid
from pathlib import Path

here = Path(__file__).resolve().parent
url = sys.argv[1] if len(sys.argv) > 1 else 'https://huhudldl.github.io/godnote/'
icon = (here / '../icons/icon-180.png').read_bytes()

# 같은 주소로 다시 만들면 같은 식별자 → 다시 설치할 때 기존 아이콘을 덮어씀
ns = uuid.UUID('6b1f3c2e-9a4d-4e57-8a1b-1d2c3e4f5a6b')
clip_id, profile_id = uuid.uuid5(ns, 'clip:' + url), uuid.uuid5(ns, 'profile:' + url)

profile = {
    'PayloadType': 'Configuration',
    'PayloadVersion': 1,
    'PayloadIdentifier': f'io.github.huhudldl.godnote.webclip.{profile_id}',
    'PayloadUUID': str(profile_id).upper(),
    'PayloadDisplayName': '갓 노트',
    'PayloadDescription': '홈 화면에 갓 노트 아이콘을 추가합니다.',
    'PayloadOrganization': '갓 노트',
    'PayloadRemovalDisallowed': False,
    'PayloadContent': [{
        'PayloadType': 'com.apple.webClip.managed',
        'PayloadVersion': 1,
        'PayloadIdentifier': f'io.github.huhudldl.godnote.webclip.{clip_id}',
        'PayloadUUID': str(clip_id).upper(),
        'PayloadDisplayName': '갓 노트 아이콘',
        'Label': '갓 노트',
        'URL': url,
        'Icon': icon,
        'IsRemovable': True,
        'FullScreen': True,        # 주소창 없이 앱처럼 열기
        'IgnoreManifestScope': False,
        'Precomposed': True,
    }],
}

out = here / 'build' / '갓 노트.mobileconfig'
out.parent.mkdir(exist_ok=True)
out.write_bytes(plistlib.dumps(profile))
print(f'완료: {out}  ({url})')
