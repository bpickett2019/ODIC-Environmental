import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ESA Pipeline - Report Assembly & QC',
  description: 'AI-powered Environmental Site Assessment report assembly and quality control',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-gray-950 text-gray-100">
        {children}
      </body>
    </html>
  )
}
