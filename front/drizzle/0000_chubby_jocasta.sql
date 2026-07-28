CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT '個' NOT NULL,
	`expires_on` text NOT NULL,
	`purchased_on` text NOT NULL,
	`image_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`confidence` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inventory_owner_expiry_idx` ON `inventory_items` (`user_email`,`status`,`expires_on`);