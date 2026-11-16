import type { ReactNode } from 'react';

export const metadata = {
  title: 'Lambda dashboard',
  description: 'Live proxy frames and TCP metadata',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
