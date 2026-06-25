import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { AuthedRequest } from "../types/auth.js";
import { withClient } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { WoohooService } from "../woohoo/woohoo.service.js";

export const ordersRouter = Router();
export const purchaseRouter = Router();

interface CartItem {
  sku: string;
  amount: number;
  quantity: number;
}

interface PurchaseBody {
  items: CartItem[];
  mobileNumber: string;
  email?: string;
  message?: string;
}

interface OrderRow {
  id: number;
  order_id: string;
  refno: string;
  items: CartItem[] | null;
  mobile_number: string;
  email: string | null;
  created_at: Date;
}

function formatMobile(mobile: string): string {
  if (mobile.length === 10 && /^\d+$/.test(mobile)) {
    return `+91${mobile}`;
  }
  return mobile;
}

ordersRouter.use(authMiddleware);
purchaseRouter.use(authMiddleware);

purchaseRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body as PurchaseBody;
    const items = body.items ?? [];
    if (!items.length || !body.mobileNumber) {
      res.status(400).json({ error: "items and mobileNumber are required." });
      return;
    }

    const client = new WoohooService();
    const refno = `ORDER-${randomBytes(6).toString("hex").toUpperCase()}`;
    const formattedMobile = formatMobile(String(body.mobileNumber));
    const orderEmail = body.email || req.auth!.email;
    const totalAmount = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);

    const orderPayload = {
      address: {
        firstname: "Giftcred",
        lastname: "User",
        email: orderEmail,
        telephone: formattedMobile,
        country: "IN",
        postcode: "560102",
      },
      billing: {
        firstname: "Giftcred",
        lastname: "User",
        email: orderEmail,
        telephone: formattedMobile,
        country: "IN",
        postcode: "560102",
      },
      payments: [{ code: "svc", amount: totalAmount }],
      refno,
      products: items.map((item) => ({
        sku: item.sku,
        price: item.amount,
        qty: item.quantity,
        currency: "356",
        deliveryMode: "API",
      })),
      deliveryMode: "API",
    };

    const result = await withClient(async (dbClient) => {
      const token = await client.authenticate(dbClient);
      const url = `${client.baseUrl}/rest/v3/orders`;
      const response = await client.catalogRequest("POST", url, {
        token,
        jsonBody: orderPayload,
        stepName: "place_order",
      });

      if (![200, 201, 202].includes(response.statusCode)) {
        return {
          error: true as const,
          status: response.statusCode,
          detail: `Order failed: ${response.body}`,
        };
      }

      const data = JSON.parse(response.body) as {
        orderId?: string;
        refno?: string;
        cards?: Array<Record<string, unknown>>;
      };

      const cards = (data.cards ?? []).map((card) => ({
        cardNumber: card.cardNumber ?? "N/A",
        cardPin: card.cardPin ?? "N/A",
        activationCode: card.activationCode ?? "N/A",
        activationUrl: card.activationUrl ?? "",
        amount: card.amount,
        validity: card.validity,
      }));

      const orderId = data.orderId;
      const responseRefno = data.refno;

      if (orderId && responseRefno) {
        const itemsDict = items.map((item) => ({
          sku: item.sku,
          amount: item.amount,
          quantity: item.quantity,
        }));
        await dbClient.query(
          `INSERT INTO orders (order_id, refno, items, mobile_number, email)
           VALUES ($1, $2, $3::jsonb, $4, $5)`,
          [orderId, responseRefno, JSON.stringify(itemsDict), body.mobileNumber, orderEmail]
        );
      }

      return {
        error: false as const,
        data: {
          success: true,
          orderId,
          refno: responseRefno,
          cards,
          placedBy: {
            userId: req.auth!.userId,
            accountId: req.auth!.accountId,
            roleSlug: req.auth!.roleSlug,
          },
        },
      };
    });

    if (result.error) {
      res.status(result.status).json({ detail: result.detail });
      return;
    }

    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const client = new WoohooService();

    const orders = await withClient(async (dbClient) => {
      const token = await client.authenticate(dbClient);
      const { rows } = await dbClient.query<OrderRow>(
        `SELECT id, order_id, refno, items, mobile_number, email, created_at
         FROM orders
         ORDER BY id DESC`
      );

      const result = [];
      for (const dbOrder of rows) {
        const url = `${client.baseUrl}/rest/v3/order/${dbOrder.order_id}/cards/?offset=0&limit=100`;
        const response = await client.catalogRequest("GET", url, {
          token,
          stepName: `fetch_order_${dbOrder.order_id}`,
        });

        let cardsData: unknown[] = [];
        if (response.statusCode === 200) {
          const apiData = JSON.parse(response.body) as { cards?: unknown[] };
          cardsData = apiData.cards ?? [];
        }

        const status =
          response.statusCode === 409
            ? "PROCESSING"
            : response.statusCode === 200
              ? "COMPLETED"
              : "FAILED";

        result.push({
          orderId: dbOrder.order_id,
          refno: dbOrder.refno,
          items: dbOrder.items ?? [],
          mobileNumber: dbOrder.mobile_number,
          email: dbOrder.email,
          createdAt: dbOrder.created_at.toISOString(),
          status,
          cards: cardsData,
          requestedBy: {
            userId: req.auth!.userId,
            accountId: req.auth!.accountId,
            roleSlug: req.auth!.roleSlug,
          },
        });
      }
      return result;
    });

    res.json(orders);
  } catch (err) {
    next(err);
  }
});
