import type { Metadata, ReactNode } from 'react';
import { SiteWrapper } from '../wrappers/site';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gatewaze Site',
  description: 'A site built on the gatewaze sites module.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteWrapper>{children}</SiteWrapper>
      </body>
    </html>
  );
}
