import { Sequelize } from 'sequelize';
import { env } from './env';

export const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',
  // Semua timestamp disimpan dalam UTC; konversi ke WIT dilakukan di utils/time.ts
  timezone: '+00:00',
  logging: false,
  define: { underscored: true },
});
