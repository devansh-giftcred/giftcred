import { Router } from "express";
import { withClient } from "../db.js";

export const catalogRouter = Router();

interface ProductRow {
  product_id: string;
  display_name: string | null;
  product_category: string | null;
  face_value_cents: number | null;
  cred_price_cents: number | null;
  supplier_base_url: string | null;
}

catalogRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await withClient((client) =>
      client.query<ProductRow>(
        `SELECT product_id, display_name, product_category, face_value_cents, supplier_base_url
         FROM gift_card_products
         WHERE is_active = TRUE`
      )
    );

    const products = rows.map((row) => ({
      sku: row.product_id,
      name: row.display_name || "Gift Card",
      brandName: row.display_name || "Brand",
      category: row.product_category || "Gift Card",
      image: row.supplier_base_url || "https://via.placeholder.com/150",
      bannerImage: row.supplier_base_url || "https://via.placeholder.com/150",
      discount: "0",
      minAmount: row.face_value_cents ? Math.floor(row.face_value_cents / 100) : 10,
      maxAmount: row.face_value_cents ? Math.floor(row.face_value_cents / 100) : 10000,
      description: "Gift Card",
      validity: "1 Year",
      howToRedeem: "",
      importantPoints: [] as string[],
    }));

    res.json(products);
  } catch (err) {
    next(err);
  }
});

catalogRouter.get("/:sku", async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const { rows } = await withClient((client) =>
      client.query<ProductRow>(
        `SELECT product_id, display_name, product_category, face_value_cents, cred_price_cents, supplier_base_url
         FROM gift_card_products
         WHERE product_id = $1`,
        [sku]
      )
    );

    const row = rows[0];
    if (!row) {
      res.status(404).json({ detail: "Product not found" });
      return;
    }

    const priceData = {
      type: "FIXED",
      denominations: row.face_value_cents
        ? [Math.floor(row.face_value_cents / 100)]
        : [100, 200, 500, 1000],
    };

    res.json({
      sku: row.product_id,
      name: row.display_name || "Gift Card",
      brandName: row.display_name || "Brand",
      category: row.product_category || "Gift Card",
      image: row.supplier_base_url || "https://via.placeholder.com/400x200",
      bannerImage: row.supplier_base_url || "https://via.placeholder.com/800x300",
      discount: "0",
      price: priceData,
      description: "Gift Card",
      validity: "1 Year",
      howToRedeem: "Redemption instructions not provided.",
      importantPoints: ["Terms and conditions apply."],
    });
  } catch (err) {
    next(err);
  }
});
