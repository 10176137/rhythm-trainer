import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rhythmtrainer.practice',
  appName: 'Rhythm Trainer',
  webDir: 'dist',
  server: { hostname: 'localhost', iosScheme: 'capacitor' },
  ios: { contentInset: 'never', preferredContentMode: 'mobile', backgroundColor: '#ffffff' },
};

export default config;
