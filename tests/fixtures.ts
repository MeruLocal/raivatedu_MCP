/**
 * Compact, representative HTML fixtures mirroring the real RaivatEdu markup
 * (SSR body text + schema.org JSON-LD). Used by offline tests so they never
 * depend on the live site.
 */

export const HOME_HTML = `<!doctype html>
<html lang="en-IN">
<head>
  <title>Education Software in India | RaivatEdu</title>
  <meta name="description" content="Education software for Indian schools, colleges and coaching institutes." />
  <link rel="canonical" href="https://www.raivatedu.com/in" />
  <script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"Organization","@id":"https://www.raivatedu.com/#organization","name":"RaivatEdu","url":"https://www.raivatedu.com","logo":{"@type":"ImageObject","url":"https://www.raivatedu.com/brand/logo.png"},"email":"hello@raivatedu.com","contactPoint":[{"@type":"ContactPoint","contactType":"sales","email":"sales@raivatedu.com"},{"@type":"ContactPoint","contactType":"customer support","email":"support@raivatedu.com"}]},
    {"@type":"SoftwareApplication","@id":"https://www.raivatedu.com/#software","name":"RaivatEdu","description":"Manage enquiries, admissions and follow-ups.","applicationCategory":"BusinessApplication","applicationSubCategory":"Education software","operatingSystem":"Web, iOS, Android",
      "offers":[
        {"@type":"Offer","name":"Starter — billed monthly","url":"https://www.raivatedu.com/in/pricing","price":3500,"priceCurrency":"INR","priceSpecification":{"@type":"UnitPriceSpecification","unitText":"per user per month"},"eligibleQuantity":{"@type":"QuantitativeValue","minValue":3,"maxValue":10}},
        {"@type":"Offer","name":"Professional — billed monthly","url":"https://www.raivatedu.com/in/pricing","price":4500,"priceCurrency":"INR","priceSpecification":{"@type":"UnitPriceSpecification","unitText":"per user per month"},"eligibleQuantity":{"@type":"QuantitativeValue","minValue":3,"maxValue":100}},
        {"@type":"Offer","name":"Enterprise — billed monthly","url":"https://www.raivatedu.com/in/pricing","price":8000,"priceCurrency":"INR","priceSpecification":{"@type":"UnitPriceSpecification","unitText":"per user per month"},"eligibleQuantity":{"@type":"QuantitativeValue","minValue":5}}
      ]}
  ]}
  </script>
  <script type="application/ld+json">{ this is intentionally broken JSON }</script>
</head>
<body>
  <nav><a href="/in/pricing">Pricing</a><a href="https://external.example.com/x">External</a></nav>
  <main>
    <h1>Turn every enquiry into an enrolled student</h1>
    <h2>Capture, qualify, nurture</h2>
    <p>Manage enquiries, admissions, follow-ups and WhatsApp communication from one workspace.</p>
    <a href="/in/features/admissions">Admissions</a>
    <script>console.log('should be stripped')</script>
  </main>
  <footer><a href="/in/contact">Contact</a></footer>
</body>
</html>`;

export const FAQ_HTML = `<!doctype html><html><head>
  <title>Pricing | RaivatEdu</title>
  <meta name="description" content="RaivatEdu pricing." />
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
    {"@type":"Question","name":"Is there a free trial?","acceptedAnswer":{"@type":"Answer","text":"Yes, 14 days with no credit card."}},
    {"@type":"Question","name":"Can I use it on mobile?","acceptedAnswer":{"@type":"Answer","text":"Yes, iOS and Android apps are available."}}
  ]}
  </script>
</head><body><main><h1>Plans and prices</h1></main></body></html>`;

/** Home page with no main/article, to exercise the body fallback. */
export const BARE_HTML = `<!doctype html><html><head><title>Bare</title></head>
<body><h1>Only a body</h1><p>fallback text</p></body></html>`;
