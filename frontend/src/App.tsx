import { BrowserRouter as Router, Routes, Route, Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useState, createContext, useContext } from "react";
import { getCatalog, placePurchaseOrder, getOrderHistory, getProduct } from "./api";
import type { Order, OrderItem } from "./api";

// --- Types ---
interface Price {
  type: string;
  min: number;
  max: number;
  denominations: number[];
}

interface Product {
  sku: string;
  name: string;
  brandName: string;
  image: string;
  bannerImage: string;
  discount: string;
  price?: Price;
  description: string;
  validity: string;
  howToRedeem: string;
  importantPoints: string[];
  category?: string;
}

interface CartItem {
  sku: string;
  brandName: string;
  amount: number;
  quantity: number;
  image: string;
  discount: string;
}

interface CartContextType {
  cart: CartItem[];
  addToCart: (item: CartItem) => void;
  removeFromCart: (sku: string, amount: number) => void;
  updateQuantity: (sku: string, amount: number, qty: number) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextType>({
  cart: [],
  addToCart: () => {},
  removeFromCart: () => {},
  updateQuantity: () => {},
  clearCart: () => {}
});

export function useCart() {
  return useContext(CartContext);
}

// --- Components ---

function Header() {
  const { cart } = useCart();
  const totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <div className="header-nav" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', padding: '10px 0', borderBottom: '1px solid #eee' }}>
      <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <h2 className="section-title" style={{ margin: 0 }}>GiftCred</h2>
      </Link>
      <div style={{ display: 'flex', gap: '15px' }}>
        <Link to="/orders" className="btn-secondary">Order History</Link>
        <Link to="/cart" className="btn-primary">
          Cart {totalItems > 0 && `(${totalItems})`}
        </Link>
      </div>
    </div>
  );
}

function Catalogue() {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    getCatalog().then((res) => setProducts(res));
  }, []);

  if (products.length === 0) return <div className="loading">Loading...</div>;

  return (
    <div className="container">
      <Header />
      <h2 className="section-title" style={{marginBottom: '20px'}}>Popular Deals</h2>
      <div className="grid">
        {products.map(product => (
          <Link key={product.sku} to={`/product/${product.sku}`} className="card-link">
            <div className="card">
              <div className="card-image-container">
                <img 
                  src={product.image} 
                  alt={product.brandName} 
                  className="card-image" 
                  onError={(e) => {
                    e.currentTarget.src = `https://placehold.co/400x200/e0e0e0/555555?text=${encodeURIComponent(product.brandName)}`;
                  }}
                />
              </div>
              <div className="card-content">
                <p className="card-category">{product.category || "Gift Card"}</p>
                <h3 className="card-brand">{product.brandName}</h3>
                <p className="card-discount">{product.discount}% Off</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function ProductDetail() {
  const { sku } = useParams();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  
  const [product, setProduct] = useState<Product | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  const [showModal, setShowModal] = useState<boolean>(false);
  const [showToast, setShowToast] = useState<boolean>(false);

  useEffect(() => {
    if (sku) {
      getProduct(sku).then(res => setProduct(res)).catch(err => console.error(err));
    }
  }, [sku]);

  if (!product) return <div className="loading">Loading...</div>;

  const priceObj = product.price || { type: "RANGE", min: 10, max: 10000, denominations: [] };
  const isFixed = priceObj.type === "FIXED" || priceObj.type === "SLAB";

  const handleAddToCart = (redirect: boolean) => {
    const amt = parseInt(amount, 10);
    if (!amt || isNaN(amt) || amt <= 0) {
      alert("Please select a valid amount.");
      return;
    }
    if (priceObj.type === "RANGE" && (amt < priceObj.min || amt > priceObj.max)) {
      alert(`Amount must be between ₹${priceObj.min} and ₹${priceObj.max}`);
      return;
    }
    
    
    addToCart({
      sku: product.sku,
      brandName: product.brandName,
      amount: amt,
      quantity,
      image: product.image,
      discount: product.discount
    });
    
    if (redirect) {
      navigate("/cart");
    } else {
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    }
  };

  const payAmount = amount ? (parseInt(amount, 10) * quantity) : 0;
  const discountedAmount = payAmount - (payAmount * parseFloat(product.discount) / 100);

  return (
    <div className="container detail-page">
      <Header />
      <div className="breadcrumb">
        <Link to="/">Home</Link> &gt; {product.brandName} Gift Card
      </div>
      
      <div className="detail-layout">
        <div className="detail-left">
          <div className="gift-card-visual">
            <img 
              src={product.bannerImage || product.image} 
              alt={product.brandName} 
              onError={(e) => { e.currentTarget.src = `https://placehold.co/600x300/e0e0e0/555555?text=${encodeURIComponent(product.brandName)}`; }}
            />
            <div className="gift-card-overlay">
              <span className="validity-badge">{product.validity}</span>
              <span className="discount-badge">upto {product.discount}% Off</span>
            </div>
          </div>
          <div className="tabs">
            <button className="tab active">Terms & Conditions</button>
            <button className="tab outline" onClick={() => setShowModal(true)}>How To Redeem</button>
          </div>
          <div className="tab-content">
            <h4>Terms & Conditions</h4>
            <ul className="terms-list">
              {product.importantPoints.map((pt, i) => <li key={i}>{pt}</li>)}
            </ul>
          </div>
        </div>

        <div className="detail-right">
          <h1 className="brand-title">{product.brandName}</h1>
          <p className="category-subtitle">{product.category || "Gift Card"}</p>
          <p className="discount-text">{product.discount}% Off</p>

          <div className="input-group amount-group">
            <label>Select Amount</label>
            
            {/* Show denomination buttons */}
            {(isFixed 
                ? priceObj.denominations 
                : [100, 200, 500, 1000].filter(d => 
                    d >= priceObj.min && d <= priceObj.max && 
                    (!priceObj.denominations || priceObj.denominations.length === 0 || priceObj.denominations.includes(d))
                  )
            ).map((d: number) => (
              <button 
                key={d}
                onClick={() => setAmount(d.toString())}
                style={{
                  padding: '8px 16px',
                  borderRadius: '8px',
                  marginRight: '10px',
                  marginBottom: '10px',
                  border: amount === d.toString() ? '2px solid #000' : '1px solid #ccc',
                  background: amount === d.toString() ? '#f0f0f0' : '#fff',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                ₹{d}
              </button>
            ))}

            {!isFixed && (
              <div className="amount-input-wrapper">
                <span className="currency-symbol">₹</span>
                <input 
                  type="number" 
                  value={amount} 
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={`Min ₹${priceObj.min} - Max ₹${priceObj.max}`}
                  min={priceObj.min}
                  max={priceObj.max}
                />
              </div>
            )}
          </div>

          <div className="input-group">
            <label>Quantity</label>
            <div className="quantity-selector">
              <button className="qty-btn" onClick={() => setQuantity(q => Math.max(1, q - 1))}>-</button>
              <span className="qty-display">{quantity}</span>
              <button className="qty-btn" onClick={() => setQuantity(q => Math.min(10, q + 1))}>+</button>
            </div>
          </div>

          <div className="payment-summary">
            <p className="you-pay-label">Subtotal</p>
            <div className="price-display">
              <span className="discounted-price">₹ {discountedAmount > 0 ? discountedAmount.toFixed(2) : "0.00"}</span>
              {amount && <span className="original-price">₹{payAmount.toFixed(2)}</span>}
            </div>
          </div>

          <div className="button-group">
            <button className="btn-outline" onClick={() => handleAddToCart(false)} disabled={!amount}>
              Add to Cart
            </button>
            <button className="btn-pay" onClick={() => handleAddToCart(true)} disabled={!amount}>
              Pay Now
            </button>
          </div>
        </div>
      </div>

      {showToast && (
        <div className="toast">
          Added to cart successfully!
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>How To Redeem</h3>
              <button className="close-btn" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <ul className="redeem-list">
                {product.howToRedeem.split('\n').map((step, idx) => <li key={idx}>{step}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Cart() {
  const { cart, removeFromCart, updateQuantity, clearCart } = useCart();
  const navigate = useNavigate();
  
  const [mobile, setMobile] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [orderResult, setOrderResult] = useState<any>(null);

  const totalPayable = cart.reduce((acc, item) => {
    const payAmt = item.amount * item.quantity;
    const discAmt = payAmt - (payAmt * parseFloat(item.discount) / 100);
    return acc + discAmt;
  }, 0);

  const handleCheckout = async () => {
    setError("");
    if (!mobile || mobile.length < 10) return setError("Valid 10-digit mobile required.");
    if (!email || !email.includes('@')) return setError("Valid email required.");

    setLoading(true);
    try {
      const data = await placePurchaseOrder({
        items: cart.map(i => ({ sku: i.sku, amount: i.amount, quantity: i.quantity })),
        mobileNumber: mobile,
        email: email
      });
      if (data.success) {
        setOrderResult(data);
        clearCart();
      } else {
        setError("Checkout failed.");
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || "Error placing order.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string) => navigator.clipboard.writeText(text);

  if (orderResult) {
    return (
      <div className="container success-container">
        <Header />
        <h2>Order Successful!</h2>
        <div className="success-details">
          <p><strong>Order Ref:</strong> {orderResult.refno}</p>
          <p>An email has been dispatched with your vouchers.</p>
          <h3>Your Vouchers (Active):</h3>
          {orderResult.cards && orderResult.cards.map((card: any, idx: number) => (
            <div key={idx} className="voucher-card">
              <p className="voucher-line">
                <strong>Card Number:</strong> <span className="voucher-code">{card.cardNumber}</span>
                <button className="copy-btn" onClick={() => handleCopy(card.cardNumber)}>Copy</button>
              </p>
              <p className="voucher-line">
                <strong>PIN:</strong> <span className="voucher-code">{card.cardPin}</span>
                <button className="copy-btn" onClick={() => handleCopy(card.cardPin)}>Copy</button>
              </p>
              {card.activationUrl && (
                <p className="voucher-line">
                  <strong>Activation URL:</strong> <a href={card.activationUrl} target="_blank" rel="noreferrer" style={{color: '#0066cc', textDecoration: 'underline'}}>{card.activationUrl}</a>
                  <button className="copy-btn" onClick={() => handleCopy(card.activationUrl)}>Copy</button>
                </p>
              )}
              <p><strong>Value:</strong> ₹{card.amount}</p>
            </div>
          ))}
        </div>
        <Link to="/" className="btn-secondary">Back to Catalogue</Link>
      </div>
    );
  }

  return (
    <div className="container">
      <Header />
      <h2 className="section-title">Your Cart</h2>
      {cart.length === 0 ? (
        <p>Your cart is empty. <Link to="/" style={{color: 'var(--primary-color)'}}>Go shopping</Link></p>
      ) : (
        <div className="detail-layout">
          <div className="detail-left">
            {cart.map((item, idx) => (
              <div key={idx} className="cart-item">
                <img src={item.image} alt={item.brandName} onError={(e) => { e.currentTarget.src = `https://placehold.co/400x200/e0e0e0/555555?text=${encodeURIComponent(item.brandName)}`; }} />
                <div className="cart-item-info">
                  <h4>{item.brandName}</h4>
                  <p className="cart-item-price">₹{item.amount} / each</p>
                  <div className="cart-actions">
                    <div className="quantity-selector" style={{ transform: 'scale(0.8)', transformOrigin: 'left' }}>
                      <button onClick={() => updateQuantity(item.sku, item.amount, item.quantity - 1)} disabled={item.quantity <= 1} className="qty-btn">-</button>
                      <span className="qty-display">{item.quantity}</span>
                      <button onClick={() => updateQuantity(item.sku, item.amount, item.quantity + 1)} className="qty-btn">+</button>
                    </div>
                    <button className="btn-remove" onClick={() => removeFromCart(item.sku, item.amount)}>Remove</button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="detail-right">
            <div className="box-panel">
              <h3>Delivery Details</h3>
              <div className="input-group mobile-group">
                <label>Mobile Number</label>
                <div className="mobile-input-wrapper">
                  <span className="country-code">+91</span>
                  <input type="tel" value={mobile} onChange={e => setMobile(e.target.value.replace(/[^0-9]/g, ''))} maxLength={10} />
                </div>
              </div>
              <div className="input-group">
                <label>Email Address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="recipient@example.com" />
              </div>
            </div>

            <div className="payment-summary" style={{ marginTop: '20px' }}>
              <p className="you-pay-label">Total to Pay</p>
              <div className="price-display">
                <span className="discounted-price">₹ {totalPayable.toFixed(2)}</span>
              </div>
            </div>

            {error && <p className="error-text">{error}</p>}
            <button className="btn-pay" onClick={handleCheckout} disabled={loading || cart.length === 0}>
              {loading ? "Processing..." : "Place Order"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderHistory() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOrderHistory().then(res => { setOrders(res); setLoading(false); }).catch(err => { console.error(err); setLoading(false); });
  }, []);

  if (loading) return <div className="loading">Loading Orders...</div>;

  return (
    <div className="container">
      <Header />
      <h2 className="section-title" style={{ marginBottom: '2rem' }}>Your Order History</h2>
      
      {orders.length === 0 ? (
        <p>No orders found.</p>
      ) : (
        <div className="orders-list">
          {orders.map(order => {
            const total = (order.items || []).reduce((acc, item) => acc + (item.amount * item.quantity), 0);
            return (
              <div key={order.orderId} className="box-panel order-card" style={{ marginBottom: '1.5rem', border: '1px solid #eaeaea', borderRadius: '12px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #eee', paddingBottom: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <p style={{margin: '0 0 5px 0'}}><strong>Order Ref:</strong> {order.refno}</p>
                    <p style={{margin: 0, color: '#666', fontSize: '0.9rem'}}><strong>Date:</strong> {new Date(order.createdAt).toLocaleString()}</p>
                    {order.email && <p style={{margin: '5px 0 0 0', color: '#666', fontSize: '0.9rem'}}><strong>Sent to:</strong> {order.email}</p>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`status-badge ${order.status.toLowerCase()}`} style={{display: 'inline-block', padding: '4px 8px', borderRadius: '4px', backgroundColor: order.status === 'COMPLETED' ? '#e6f4ea' : '#fef7e0', color: order.status === 'COMPLETED' ? '#137333' : '#b06000', fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '5px'}}>{order.status}</span>
                    <p style={{margin: 0, fontWeight: 'bold'}}>Total: ₹{total}</p>
                  </div>
                </div>
                
                <h4 style={{marginBottom: '10px'}}>Activated Gift Cards</h4>
                {order.cards && order.cards.length > 0 ? (
                  order.cards.map((card, idx) => (
                    <div key={idx} className="voucher-card" style={{ marginTop: '10px', backgroundColor: '#fafafa' }}>
                      <p className="voucher-line"><strong>Card Number:</strong> <span className="voucher-code">{card.cardNumber}</span></p>
                      <p className="voucher-line"><strong>PIN:</strong> <span className="voucher-code">{card.cardPin}</span></p>
                      {card.activationUrl && (
                        <p className="voucher-line" style={{marginTop: '5px'}}>
                          <strong>Activation URL:</strong> <a href={card.activationUrl} target="_blank" rel="noreferrer" style={{color: '#0066cc', textDecoration: 'underline'}}>{card.activationUrl}</a>
                        </p>
                      )}
                      <p style={{margin: 0, marginTop: '5px', fontSize: '0.9rem'}}><strong>Value:</strong> ₹{card.amount} <span style={{marginLeft: '15px'}}><strong>Status:</strong> {card.status || 'Active'}</span></p>
                    </div>
                  ))
                ) : (
                  <p style={{color: '#666'}}>No cards available yet. Still processing.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function App() {
  const [cart, setCart] = useState<CartItem[]>([]);

  const addToCart = (item: CartItem) => {
    setCart(prev => {
      const existing = prev.find(i => i.sku === item.sku && i.amount === item.amount);
      if (existing) {
        return prev.map(i => i.sku === item.sku && i.amount === item.amount ? { ...i, quantity: i.quantity + item.quantity } : i);
      }
      return [...prev, item];
    });
  };

  const removeFromCart = (sku: string, amount: number) => {
    setCart(prev => prev.filter(i => !(i.sku === sku && i.amount === amount)));
  };

  const updateQuantity = (sku: string, amount: number, quantity: number) => {
    setCart(prev => prev.map(i => (i.sku === sku && i.amount === amount) ? { ...i, quantity } : i));
  };

  const clearCart = () => setCart([]);

  return (
    <CartContext.Provider value={{ cart, addToCart, removeFromCart, updateQuantity, clearCart }}>
      <Router>
        <div className="app">
          <Routes>
            <Route path="/" element={<Catalogue />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/orders" element={<OrderHistory />} />
            <Route path="/product/:sku" element={<ProductDetail />} />
          </Routes>
        </div>
      </Router>
    </CartContext.Provider>
  );
}

export default App;
