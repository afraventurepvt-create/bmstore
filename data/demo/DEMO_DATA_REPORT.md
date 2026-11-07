# Demo data report

Scope: this folder only (`data/demo`). Nothing else in the repository was touched. No importer exists yet in `apps/api`, so the CSVs use exactly the columns requested; a later step maps them onto whatever template the importer ends up with.

## What is in the folder

| File | Contents |
|---|---|
| `silks.csv` | Meenakshi Silks, 25 products, 5 categories |
| `foods.csv` | Anna Foods, 25 products, 6 categories |
| `jewels.csv` | Sri Gold Jewels, 25 products, 5 categories |
| `stores.json` | One entry per store: name, slug/subdomain, English + Tamil tagline, About text, fictional address and phone, shipping settings, suggested theme, category list |
| `IMAGE_SHOPPING_LIST.md` | 75 product shots (one per product, keyed by `image_filename`) plus 6 store-level images and general shooting rules |
| `build_demo_data.py` | Generator. All product data lives in this file; it validates and rewrites the CSVs, JSON and image list. Run `python3 data/demo/build_demo_data.py`. Delete it if you prefer to hand-edit the CSVs from here on. |

CSV columns, in order: `name, description, price, mrp, sku, stock, category, hsn_code, image_filename`. UTF-8, comma-separated, RFC 4180 quoting, header row, no BOM. Prices and MRP are whole rupees, GST-inclusive (the usual retail convention; change if the importer expects exclusive prices).

## Catalogue summary

| Store | Rows | Price range | Median price | Categories | Total stock |
|---|---:|---:|---:|---|---:|
| Meenakshi Silks | 25 | ₹499 – ₹12,999 | ₹1,499 | Silk Sarees (8), Cotton Sarees (5), Veshti & Angavastram (4), Kids Wear (4), Readymade & Blouses (4) | 341 |
| Anna Foods | 25 | ₹45 – ₹899 | ₹140 | Savouries (5), Sweets (6), Spices & Masalas (5), Pickles & Podis (3), Millets & Rice (3), Oils & Coffee (3) | 1,175 |
| Sri Gold Jewels | 25 | ₹99 – ₹2,499 | ₹699 | Temple Jewellery (6), Bangles (5), Earrings (5), Bridal Sets (4), Hair & Accessories (5) | 459 |

Every row has `mrp >= price`, a unique SKU (`MS-`, `AF-`, `SGJ-` prefixes with a category code), a unique name, a unique image filename and a positive stock. The generator asserts all of this plus the price bands above, and fails if any product text contains "review", "rating", "bestseller", "sold" or "testimonial".

Pack sizes and ages/sizes are in the product name (foods: "– 250 g", kids: "Age 2–3") so they survive any importer. Size and colour choices (bangle sizes 2.4/2.6/2.8, blouse sizes 32–40, pavadai ages) are mentioned in descriptions; they are candidates for `Variant` rows once the importer supports them, not separate products.

## What was deliberately left out

- No reviews, star ratings, order counts, "X people bought this", "bestseller" labels or testimonials anywhere (CSVs, stores.json, image list).
- No founding years, awards, certifications (Silk Mark, FSSAI, organic) or "since 19xx" claims in the About texts.
- No real phone numbers. All three support/WhatsApp numbers are `+91 00000 0000x`, which cannot be dialled. Emails use the reserved `.example` domain. GST numbers are `null`; the Anna Foods entry also has `fssai_license: null` as a reminder that a food seller must display one.
- Addresses use real streets in Kanchipuram, Madurai and T. Nagar with made-up door numbers, so they geocode plausibly but do not point at a real business. `stores.json` carries a `demo_notice` on each store saying so.

## HSN codes used

Indian Customs Tariff / GST HSN. GST invoices need 4 digits (turnover up to ₹5 crore) or 6 digits (above); 8-digit lines are given where the Indian tariff has a specific sub-heading, and can be truncated to 6 for invoicing. Rates are not included in the CSVs because the September 2025 rate revision moved several of these lines; confirm the current rate per line with your CA before enabling tax calculation.

| HSN | Description | Used for |
|---|---|---|
| 50072010 | Woven silk fabric, ≥85% silk: sarees | Kanchipuram, Arani, Mysore crepe silk sarees |
| 500720 | Woven silk fabric, ≥85% silk, other than sarees | Pure silk veshti set |
| 540752 | Woven fabric of textured polyester filament, dyed | Semi-silk (art silk) saree. **Check with the supplier:** if the yarn is viscose rather than polyester the heading is 5408. |
| 52084220 | Cotton woven fabric, yarn-dyed, plain weave >100 g/m²: saree | Chettinad and Negamam handloom cottons |
| 52083220 | Cotton woven fabric, dyed, plain weave >100 g/m²: saree | Madurai sungudi, Coimbatore soft cotton |
| 52082110 | Cotton woven fabric, bleached, plain weave ≤100 g/m²: dhoti | Cotton veshti and veshti-angavastram set |
| 621410 | Shawls, scarves and the like, of silk | Silk angavastram |
| 620429 | Women's/girls' ensembles, other textile materials | Girls' pattu pavadai (silk skirt + blouse) sets |
| 620322 | Men's/boys' ensembles, cotton | Boys' veshti sattai set |
| 620442 | Girls' dresses, cotton | Chettinad check frock |
| 620610 / 620630 | Women's blouses, silk / cotton | Readymade blouses |
| 620520 / 620530 | Men's shirts, cotton / man-made fibres | Cotton shirt, art silk jibba |
| 21069099 | Food preparations not elsewhere specified | Murukku, thattai, mixture, ribbon pakoda (namkeen); Mysore pak, adhirasam, halwa, laddu (sweetmeats); idli podi |
| 19059040 | Papad | Appalam |
| 170490 | Sugar confectionery not containing cocoa | Peanut chikki (kadalai mittai) |
| 17029010 | Palmyra sugar | Karupatti |
| 09109100 | Mixtures of spices | Sambar powder, rasam powder |
| 09042211 | Chilli powder | Mundu chilli powder |
| 09103030 | Turmeric powder | Erode turmeric |
| 09041130 | Black pepper, whole | Kolli Hills pepper |
| 20019000 | Vegetables/fruit prepared or preserved by vinegar or acetic acid | Mango and lime pickle (the heading Indian oil pickles are conventionally filed under; some sellers use 2008 for fruit pickles, confirm) |
| 10082930 / 10082920 / 10082990 | Millets: ragi / bajra (kambu) / other (thinai) | Whole millets |
| 15155091 | Sesame oil, edible grade | Cold-pressed gingelly oil |
| 15089091 | Groundnut oil, edible grade | Cold-pressed groundnut oil |
| 09019020 | Coffee substitutes containing coffee | 80:20 coffee-chicory filter coffee (a 100% coffee powder would be 090121) |
| 71171990 | Imitation jewellery of base metal, other | All brass/alloy temple jewellery, earrings, sets, anklets, toe rings, kada, tikka |
| 71171910 | Imitation jewellery of base metal: bangles | Kemp and antique metal bangles |
| 70181010 | Glass bangles | Glass bangle set |
| 71179090 | Imitation jewellery, not of base metal, other | Silk thread bangles |
| 71179010 | Imitation jewellery studded with imitation pearls or stones | Guttapusalu pearl choker set (pearl clusters are the essential character) |
| 961590 | Hair-slides and the like | Jadai billai braid ornaments (pinned into the hair, so Chapter 96 rather than 7117) |
| 580890 | Tassels, pompons and similar articles | Jadai kunjalam |

Lines I would double-check with a CA before invoicing: the 8-digit saree/dhoti sub-lines under 5208 (the 6-digit parents 520842, 520832, 520821 are safe), the art silk saree (5407 vs 5408), pickles (2001 vs 2008), and jadai billai (9615 vs 7117).

## stores.json and the Prisma schema

The JSON keys were chosen to line up with `apps/api/prisma/schema.prisma`:

- `name`, `slug`, `subdomain`, `address` (flatten to one line for `Tenant.address`), `support_phone`, `whatsapp_number`, `gst_number` → `Tenant`.
- `settings.shipping_mode|flat_rate|free_above|cod_enabled|cod_charge|order_prefix` → `Settings` (enum values `flat|free|free_above` match `ShippingMode`). `dispatch_note` and `returns_note` have no column yet; they belong in policy `Page` rows.
- `theme.layout_variant|palette_id|primary_color|secondary_color|font_pair_id|header_style|card_style|homepage_sections` → `ThemeConfig`. The palette and font-pair ids (`arakku-gold`, `playfair-lato`, …) and the section names are suggestions: the codebase does not define a theme vocabulary yet, so rename them to whatever the theme system adopts. Hex colours are concrete and can be used as-is.
- `tagline.en`, `tagline.ta`, `about`, `support_email`, `categories` have no column today. Tagline and About are natural `Page` content or future `Tenant` fields; `categories` is the ordered list to create as `Category` rows (slugify the names) before importing products, since products reference categories by name.
- `Product.status` defaults to `draft`; the importer should set `active` for demo rows, and put `image_filename` into `images[]` once the files exist at whatever public URL prefix is chosen.

Theme suggestions in one line each: Meenakshi Silks V1 classic, arakku maroon `#7B1E2B` + gold `#C9A227` on ivory, Playfair Display + Lato. Anna Foods V2 dense grid, leaf green `#2F6B3A` + turmeric `#E0A526` on cream, Poppins + Nunito. Sri Gold Jewels V3 editorial, near-black `#1F1A17` + rose gold `#B76E79` on ivory, Cormorant Garamond + Montserrat.

## Open points for you

1. **Store name vs. goods.** "Sri Gold Jewels" sells only imitation jewellery. The About text says so in plain words; keep that disclosure wherever the name appears (hero, invoices) so the name cannot be read as a gold claim.
2. **Legal Metrology / FSSAI.** Food packs carry net quantity in the name and MRP in the sheet; a live store would also need packing date, best-before, FSSAI number and manufacturer address on the label and the product page. Placeholders are flagged in `stores.json`.
3. **Pricing basis.** Prices are MRP-inclusive of GST. If the importer or invoice wants tax-exclusive base prices, derive them from the rate per HSN line rather than editing the CSV.
4. **Variants.** Sizes/ages/bangle sizes are described but not modelled; decide whether the importer creates `Variant` rows from a column or whether they are added by hand afterwards.
5. **Images.** None exist yet; `image_filename` values are the names to save your shots under. `IMAGE_SHOPPING_LIST.md` describes each shot and the licensing rule (own, supplier-permitted or licensed images only).
