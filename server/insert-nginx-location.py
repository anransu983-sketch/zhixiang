#!/usr/bin/env python3
# Insert the /zhixiang-logs/ location into an nginx server block, exactly once.
# Usage (as root): python3 insert-nginx-location.py /etc/nginx/conf.d/myprobe.conf
# The script only edits the file and reports; it never reloads nginx.
# (sed '0,/re/r file' was observed to insert the block twice, so we do it here.)
import shutil
import sys

BLOCK = [
    '    location /zhixiang-logs/ {\n',
    '        proxy_pass http://127.0.0.1:18091;\n',
    '        proxy_set_header Host $host;\n',
    '        proxy_set_header X-Real-IP $remote_addr;\n',
    '        client_max_body_size 1m;\n',
    '    }\n',
]


def main() -> int:
    path = sys.argv[1]
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    if any('zhixiang-logs' in line for line in lines):
        print('already present, nothing changed')
        return 0
    # Split the file into server blocks (a block starts at a line that is
    # exactly "server {"). Prefer the block that listens on 443 and names
    # probe.suanran9527.com; fall back to the first probe line anywhere.
    starts = [i for i, line in enumerate(lines) if line.strip() == 'server {']

    def block_end(start: int) -> int:
        for j in range(start + 1, len(lines)):
            if lines[j].strip() == 'server {':
                return j
        return len(lines)

    name_idx = None
    for start in starts:
        end = block_end(start)
        chunk = lines[start:end]
        if (any('listen' in line and '443' in line for line in chunk)
                and any('probe.suanran9527.com' in line for line in chunk)):
            name_idx = next(i for i in range(start, end)
                            if 'probe.suanran9527.com' in lines[i])
            break
    if name_idx is None:
        name_idx = next((i for i, line in enumerate(lines)
                         if 'probe.suanran9527.com' in line), None)
    if name_idx is None:
        print('server_name line not found, nothing changed')
        return 1
    shutil.copy(path, path + '.bak-zxlogs5')
    lines[name_idx + 1:name_idx + 1] = BLOCK
    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    count = sum(1 for line in lines if 'zhixiang-logs' in line)
    print(f'inserted after line {name_idx + 1}; '
          f'zhixiang-logs lines now: {count} (must be 1)')
    return 0 if count == 1 else 2


if __name__ == '__main__':
    sys.exit(main())
