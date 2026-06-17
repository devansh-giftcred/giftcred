import uuid
import json
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import init_db, get_session
from woohoo_client import WoohooClient
from models import Order

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def on_startup():
    init_db()

from typing import List

class CartItem(BaseModel):
    sku: str
    amount: int
    quantity: int

class PurchaseRequest(BaseModel):
    items: List[CartItem]
    mobileNumber: str
    email: str
    message: str = ""

from sqlalchemy import text

@app.get("/api/catalog")
def get_catalog():
    try:
        with get_session() as session:
            result = session.execute(text("SELECT product_id, display_name, product_category, face_value_cents, supplier_base_url FROM gift_card_products WHERE is_active = true"))
            products = []
            for row in result:
                product_id, display_name, category, face_value, image_url = row
                products.append({
                    "sku": product_id,
                    "name": display_name or "Gift Card",
                    "brandName": display_name or "Brand",
                    "category": category or "Gift Card",
                    "image": image_url or "https://via.placeholder.com/150",
                    "bannerImage": image_url or "https://via.placeholder.com/150",
                    "discount": "0",
                    "minAmount": int(face_value / 100) if face_value else 10,
                    "maxAmount": int(face_value / 100) if face_value else 10000,
                    "description": "Gift Card",
                    "validity": "1 Year",
                    "howToRedeem": "",
                    "importantPoints": []
                })
            return products
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/catalog/{sku}")
def get_product(sku: str):
    try:
        with get_session() as session:
            result = session.execute(
                text("SELECT product_id, display_name, product_category, face_value_cents, cred_price_cents, supplier_base_url FROM gift_card_products WHERE product_id = :sku"),
                {"sku": sku}
            ).fetchone()
            
            if not result:
                raise HTTPException(status_code=404, detail="Product not found")
                
            product_id, display_name, category, face_value, cred_price, image_url = result
            
            price_data = {
                "type": "RANGE",
                "min": 10,
                "max": 10000,
                "denominations": [100, 200, 500, 1000]
            }
                
            return {
                "sku": product_id,
                "name": display_name or "Gift Card",
                "brandName": display_name or "Brand",
                "category": category or "Gift Card",
                "image": image_url or "https://via.placeholder.com/400x200",
                "bannerImage": image_url or "https://via.placeholder.com/800x300",
                "discount": "0",
                "price": price_data,
                "description": "Gift Card",
                "validity": "1 Year",
                "howToRedeem": "Redemption instructions not provided.",
                "importantPoints": ["Terms and conditions apply."]
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/purchase")
def place_order(req: PurchaseRequest):
    client = WoohooClient()
    refno = f"ORDER-{uuid.uuid4().hex[:12].upper()}"
    
    # Format telephone number to +91 if exactly 10 digits
    formatted_mobile = req.mobileNumber
    if len(formatted_mobile) == 10 and formatted_mobile.isdigit():
        formatted_mobile = f"+91{formatted_mobile}"
    
    order_payload = {
        "address": {
            "firstname": "Test",
            "lastname": "User",
            "email": req.email,
            "telephone": formatted_mobile,
            "country": "IN",
            "postcode": "560102"
        },
        "billing": {
            "firstname": "Test",
            "lastname": "User",
            "email": req.email,
            "telephone": formatted_mobile,
            "country": "IN",
            "postcode": "560102"
        },
        "payments": [
            {
                "code": "svc",
                "amount": sum(item.amount * item.quantity for item in req.items)
            }
        ],
        "refno": refno,
        "products": [
            {
                "sku": "UBEFLOW",
                "price": item.amount,
                "qty": item.quantity,
                "currency": "356",
                "deliveryMode": "API"
            } for item in req.items
        ],
        "deliveryMode": "API"
    }
    
    with get_session() as session:
        token = client.authenticate(session)
        url = f"{client.base_url}/rest/v3/orders"
        
        response = client._catalog_request(
            "POST",
            url,
            token=token,
            json_body=order_payload,
            step_name="place_order"
        )
        
        if response.status_code in [200, 201, 202]:
            data = json.loads(response.body)
            # Find the card details in the response
            cards = []
            if "cards" in data:
                for card in data["cards"]:
                    cards.append({
                        "cardNumber": card.get("cardNumber", "N/A"),
                        "cardPin": card.get("cardPin", "N/A"),
                        "activationCode": card.get("activationCode", "N/A"),
                        "activationUrl": card.get("activationUrl", ""),
                        "amount": card.get("amount"),
                        "validity": card.get("validity")
                    })
            order_id = data.get("orderId")
            response_refno = data.get("refno")
            if order_id and response_refno:
                # Convert Pydantic items to dicts
                items_dict = [{"sku": item.sku, "amount": item.amount, "quantity": item.quantity} for item in req.items]
                new_order = Order(
                    order_id=order_id,
                    refno=response_refno,
                    items=items_dict,
                    mobile_number=req.mobileNumber,
                    email=req.email
                )
                session.add(new_order)
                session.commit()
                
            return {"success": True, "orderId": order_id, "refno": response_refno, "cards": cards}
        else:
            raise HTTPException(status_code=response.status_code, detail=f"Order failed: {response.body}")

@app.get("/api/orders")
def get_orders():
    client = WoohooClient()
    try:
        with get_session() as session:
            token = client.authenticate(session)
            db_orders = session.query(Order).order_by(Order.id.desc()).all()
            
            result = []
            for db_order in db_orders:
                url = f"{client.base_url}/rest/v3/order/{db_order.order_id}/cards/?offset=0&limit=100"
                response = client._catalog_request("GET", url, token=token, step_name=f"fetch_order_{db_order.order_id}")
                
                cards_data = []
                if response.status_code == 200:
                    api_data = json.loads(response.body)
                    cards_data = api_data.get("cards", [])
                
                result.append({
                    "orderId": db_order.order_id,
                    "refno": db_order.refno,
                    "items": db_order.items or [],
                    "mobileNumber": db_order.mobile_number,
                    "email": db_order.email,
                    "createdAt": db_order.created_at.isoformat(),
                    "status": "PROCESSING" if response.status_code == 409 else "COMPLETED" if response.status_code == 200 else "FAILED",
                    "cards": cards_data
                })
            
            return result
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
