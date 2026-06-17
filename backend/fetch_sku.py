import json
from database import init_db, get_session
from woohoo_client import WoohooClient

def fetch_sku(sku: str):
    client = WoohooClient()
    with get_session() as session:
        token = client.authenticate(session)
        
        url = f"{client.base_url}/rest/v3/catalog/products/{sku}"
        
        response = client._catalog_request(
            "GET", 
            url, 
            token=token, 
            step_name=f"fetch_product_{sku}"
        )
        
        if response.status_code == 200:
            data = json.loads(response.body)
            print(json.dumps(data, indent=2))
        else:
            print(f"FAILED: {response.status_code}")
            print(response.body)

if __name__ == "__main__":
    init_db()
    fetch_sku("UBEFLOW")
