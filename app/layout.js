import "./globals.css";

export const metadata = {
  title: "Market Fuzion — Prospecting Command Center",
  description: "Research and prepare leads. You approve. You send.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
