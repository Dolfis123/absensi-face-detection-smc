import { app } from './app';
import { bootstrap } from './bootstrap';
import { env } from './config/env';

bootstrap()
  .then(() => {
    app.listen(env.port, () => console.log(`🚗 SMC-FaceAttend API berjalan di http://localhost:${env.port}`));
  })
  .catch((err) => {
    console.error('Gagal menyiapkan database:', err);
    process.exit(1);
  });
