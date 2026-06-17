import psycopg2
import json
from urllib.parse import urlparse
from datetime import datetime
import decimal
from uuid import UUID

def default_serializer(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    if isinstance(obj, UUID):
        return str(obj)
    raise TypeError(f'Type {type(obj)} not serializable')

url = 'postgres://postgres:xPdSL7MeFVFbojNyXfLyFkePDokeYxiR6kgLF6BzAGV6McO4iV4sGp82bdIjHA49@89.167.107.138:5432/postgres'
result = urlparse(url)

try:
    conn = psycopg2.connect(database=result.path[1:], user=result.username, password=result.password, host=result.hostname, port=result.port)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    tables = [t[0] for t in cur.fetchall()]
    
    backup_data = {}
    for t_name in tables:
        cur.execute(f'SELECT * FROM "{t_name}"')
        rows = cur.fetchall()
        cols = [desc[0] for desc in cur.description]
        backup_data[t_name] = [dict(zip(cols, row)) for row in rows]
    
    with open('remote_db_backup.json', 'w') as f:
        json.dump(backup_data, f, default=default_serializer, indent=2)
    print('Backup saved to remote_db_backup.json')
    cur.close()
    conn.close()
except Exception as e:
    print('Error:', e)
