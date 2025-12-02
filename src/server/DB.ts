import { Pool } from "pg";

// Connection pool to Railway PostgreSQL
export const db = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway provides this
  ssl: { rejectUnauthorized: false },         // required for Railway's SSL
});
