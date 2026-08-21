import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cutline.editor',
  appName: 'Cutline',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: { backgroundColor: '#0c0b10' }
};

export default config;
