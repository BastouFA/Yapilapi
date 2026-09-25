import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}
migrate(url).catch((err) => {
  console.error(err);
  process.exit(1);
});
