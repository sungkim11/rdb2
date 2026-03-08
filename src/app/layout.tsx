import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'rdb2',
  description: 'Desktop-first Postgres client built with Tauri and Rust.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
