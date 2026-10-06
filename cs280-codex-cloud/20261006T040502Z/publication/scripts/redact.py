import collections, datetime, hashlib, ipaddress, json, os, pathlib, re, shutil, subprocess, sys, urllib.parse, zipfile
secret_key = re.compile('^(?:password|passwd|secret|client_secret|credential|credentials|access_token|refresh_token|token|authorization|auth|integrityToken|nonce|signature|privateKey|private_key|publicKey|public_key|key|api_key|apiKey|hmac_key|encrypted_key|download_url|b64_string)$', re.I)
resource_key = re.compile('^(?:id|file_?id|folder_?id|directory_?id|library_?file_?id|parent_?id|parent_?ids|parentFolderId|fileParentId|parents|drive_?id)$', re.I)
email_key = re.compile('^(?:email|emailAddress|account|accountName|displayName|userName)$', re.I)

def discover_ids(value, key=''):
    if isinstance(value, dict):
        for k, v in value.items():
            discover_ids(v, k)
    elif isinstance(value, list):
        for v in value:
            discover_ids(v, key)
    elif isinstance(value, str) and resource_key.match(key):
        if re.fullmatch('1[A-Za-z0-9_-]{24,43}', value) and (not re.fullmatch('[0-9a-f]{40}', value)):
            ids.add(value)
patterns = [('PEM_KEY_OR_CERTIFICATE', re.compile('-----BEGIN (?:[A-Z0-9 ]*(?:KEY|CERTIFICATE))-----.*?-----END [A-Z0-9 ]+-----', re.S)), ('CREDENTIAL_TOKEN', re.compile('\\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\\b')), ('BEARER_VALUE', re.compile('(?i)\\bBearer\\s+[A-Za-z0-9._~+/-]+=*')), ('JWT_VALUE', re.compile('\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b')), ('ACCOUNT_EMAIL', re.compile('\\b[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b')), ('PRIVATE_RESOURCE', re.compile('\\b(?:libfile|libdir|file)_[A-Za-z0-9_-]{10,}\\b|[REDACTED:PRIVATE_RESOURCE]"\\\'<>]+')), ('PRIVATE_HOME', re.compile('(?:[REDACTED:PRIVATE_HOME]/\\s"\\\'<>]+|[REDACTED:PRIVATE_HOME]/\\s"\\\'<>]+|[REDACTED:PRIVATE_HOME](?=/|\\b)|[REDACTED:PRIVATE_HOME]|[A-Z]:[/\\\\](?:Users[/\\\\][^/\\\\\\s"\\\'<>]+|codex|claude))', re.I)), ('PRIVATE_ATTACHMENT', re.compile('/workspace/attachments/[A-Za-z0-9_-]+')), ('SOCKET_PATH', re.compile('(?:/[A-Za-z0-9_.-]+)+\\.(?:sock|socket)\\b|\\\\\\\\\\.\\\\pipe\\\\[^\\s"\\\'<>]+')), ('ACCOUNT_NAME', re.compile('(?<![A-Za-z0-9_])(?:[REDACTED:ACCOUNT_NAME]|[REDACTED:ACCOUNT_NAME])(?![A-Za-z0-9_])'))]
ipv4 = re.compile('(?<![A-Za-z0-9.])(?:\\d{1,3}\\.){3}\\d{1,3}(?![A-Za-z0-9.])')
ipv6 = re.compile('(?<![A-Za-z0-9])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:]{0,39}(?![A-Za-z0-9])')
urls = re.compile('https?://[^\\s"\\\'<>`]+')
assignment = re.compile('(?i)(\\b(?:token|password|passwd|client_secret|api_key|authorization|nonce|private_key|public_key|hmac_key)\\s*[=:]\\s*)([A-Za-z0-9_+/.~-]{8,})')

def redact_text(text, counts):
    for kind, pattern in patterns:
        text, n = pattern.subn('[REDACTED:' + kind + ']', text)
        counts[kind] += n
    for resource in ids:
        text, n = re.subn(re.escape(resource), '[REDACTED:PRIVATE_RESOURCE]', text)
        counts['PRIVATE_RESOURCE'] += n

    def strip_url(match):
        value = match.group(0)
        parsed = urllib.parse.urlsplit(value)
        if parsed.username is not None or parsed.password is not None:
            value = parsed._replace(netloc=parsed.hostname or '').geturl()
            counts['URL_CREDENTIAL'] += 1
        if urllib.parse.urlsplit(value).query:
            value = value.split('?', 1)[0] + '?REDACTED_QUERY'
            counts['URL_QUERY'] += 1
        if re.search('https?://(?:docs|drive)\\.google\\.com/(?:file/d/|drive/folders/|document/d/|spreadsheets/d/|presentation/d/)', value):
            value = re.sub('((?:file|document|spreadsheets|presentation)/d/|drive/folders/)[^/?#]+', '\\1REDACTED_RESOURCE', value)
            counts['PRIVATE_RESOURCE_URL'] += 1
        return value
    text = urls.sub(strip_url, text)

    def mask_ip(match):
        value = match.group(0)
        try:
            ipaddress.ip_address(value)
        except ValueError:
            return value
        counts['IP_ADDRESS'] += 1
        return '[REDACTED:IP_ADDRESS]'
    text = ipv4.sub(mask_ip, text)
    text = ipv6.sub(mask_ip, text)
    text, n = assignment.subn('\\1[REDACTED:SECRET_ASSIGNMENT]', text)
    counts['SECRET_ASSIGNMENT'] += n
    return text

def walk(value, counts, key=''):
    policy_object = key == 'authorization' and isinstance(value, dict) and (set(value) <= {'allowedActions', 'prohibitedActions', 'approvalRequired'})
    if value is not None and secret_key.match(key) and (not policy_object):
        counts['SECRET_FIELD'] += 1
        return '[REDACTED:SECRET_FIELD]'
    if value is not None and email_key.match(key) and isinstance(value, str):
        counts['ACCOUNT_FIELD'] += 1
        return '[REDACTED:ACCOUNT_FIELD]'
    if isinstance(value, dict):
        return {k: walk(v, counts, k) for k, v in value.items()}
    if isinstance(value, list):
        return [walk(v, counts, key) for v in value]
    if isinstance(value, str):
        return redact_text(value, counts)
    return value

def redacted_bytes(data, suffix):
    text = data.decode('utf-8')
    counts = collections.Counter()
    if suffix == '.json':
        text = json.dumps(walk(json.loads(text), counts), ensure_ascii=False, indent=2) + '\n'
    elif suffix == '.jsonl':
        text = ''.join((json.dumps(walk(json.loads(line), counts), ensure_ascii=False) + '\n' for line in text.splitlines() if line.strip()))
    else:
        lines = []
        for line in text.splitlines(keepends=True):
            try:
                if line.lstrip().startswith(('{', '[')):
                    item = json.loads(line)
                    lines.append(json.dumps(walk(item, counts), ensure_ascii=False) + '\n')
                    continue
            except ValueError:
                pass
            lines.append(redact_text(line, counts))
        text = ''.join(lines)
    return (text.encode(), {k: v for k, v in counts.items() if v})
