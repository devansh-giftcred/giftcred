import psycopg2
from urllib.parse import urlparse

url = 'postgres://postgres:xPdSL7MeFVFbojNyXfLyFkePDokeYxiR6kgLF6BzAGV6McO4iV4sGp82bdIjHA49@89.167.107.138:5432/postgres'
result = urlparse(url)

try:
    conn = psycopg2.connect(
        database=result.path[1:],
        user=result.username,
        password=result.password,
        host=result.hostname,
        port=result.port
    )
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    tables = cur.fetchall()
    print('Tables in database:', tables)
    for table in tables:
        t_name = table[0]
        cur.execute(f'SELECT * FROM "{t_name}" LIMIT 5')
        rows = cur.fetchall()
        
        # get column names
        cols = [desc[0] for desc in cur.description]
        print(f'\nTable: {t_name}')
        print("Columns:", cols)
        for r in rows:
            print(r)
    cur.close()
    conn.close()
except Exception as e:
    print('Error:', e)
