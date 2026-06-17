import axios from 'axios';

const API_BASE = "http://127.0.0.1:8000/api";

export interface GiftCard {
    cardNumber: string;
    cardPin: string;
    amount: string;
    validity: string;
    activationCode?: string;
    status?: string;
}

export interface OrderItem {
    sku: string;
    amount: number;
    quantity: number;
}

export interface Order {
    orderId: string;
    refno: string;
    items: OrderItem[];
    mobileNumber: string;
    email: string;
    createdAt: string;
    status: string;
    cards: GiftCard[];
}

export const getCatalog = async (): Promise<any[]> => {
  const response = await axios.get(`${API_BASE}/catalog`);
  return response.data;
};

export const getProduct = async (sku: string): Promise<any> => {
  const response = await axios.get(`${API_BASE}/catalog/${sku}`);
  return response.data;
};

export const placePurchaseOrder = async (orderData: {
  items: { sku: string; amount: number; quantity: number }[];
  mobileNumber: string;
  email: string;
  message?: string;
}) => {
  const response = await axios.post(`${API_BASE}/purchase`, orderData);
  return response.data;
};

export const getOrderHistory = async (): Promise<Order[]> => {
  const response = await axios.get(`${API_BASE}/orders`);
  return response.data;
};
