import { app } from './app';
import { bootstrap } from './bootstrap';
import { env } from './config/env';

bootstrap()
  .then(() => {
    app.listen(env.port, env.host, () => console.log(`🚗 SMC-FaceAttend API berjalan di http://${env.host}:${env.port}`));
  })
  .catch((err) => {
    console.error('Gagal menyiapkan database:', err);
    process.exit(1);
  });
