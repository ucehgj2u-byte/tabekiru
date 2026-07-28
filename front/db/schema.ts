import { sql } from "drizzle-orm";
import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    id: text("id").primaryKey(),
    userEmail: text("user_email").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    quantity: real("quantity").notNull().default(1),
    unit: text("unit").notNull().default("個"),
    expiresOn: text("expires_on").notNull(),
    purchasedOn: text("purchased_on").notNull(),
    imageKey: text("image_key"),
    status: text("status").notNull().default("active"),
    confidence: real("confidence"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("inventory_owner_expiry_idx").on(
      table.userEmail,
      table.status,
      table.expiresOn,
    ),
  ],
);
