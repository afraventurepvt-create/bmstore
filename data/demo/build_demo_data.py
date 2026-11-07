#!/usr/bin/env python3
"""Builds the BMStore demo catalogue: silks.csv, foods.csv, jewels.csv, stores.json,
IMAGE_SHOPPING_LIST.md. Run from anywhere:  python3 data/demo/build_demo_data.py
All business details (addresses, phones) are fictional. No reviews/ratings/order counts anywhere."""
import csv, json, os, re, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLUMNS = ["name", "description", "price", "mrp", "sku", "stock", "category", "hsn_code", "image_filename"]

def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s

# ---------------------------------------------------------------- Meenakshi Silks
SILKS = [
 # Silk Sarees
 dict(name="Kanchipuram Pure Silk Saree – Arakku Maroon with Gold Zari Border",
      description="Handwoven Kanchipuram pure mulberry silk saree in deep arakku maroon with a 4-inch gold zari rudraksham border and a contrast korvai pallu. 6.2 m including an unstitched blouse piece.",
      price=8999, mrp=10499, sku="MS-SS-001", stock=6, category="Silk Sarees", hsn="50072010",
      photo="Full saree draped on a dress form, front view, pallu over the left shoulder; pleats showing the maroon body and the gold rudraksham border; plain ivory or warm grey backdrop. Detail shot: close-up of border weave and pallu motif."),
 dict(name="Kanchipuram Silk Saree – Peacock Blue with Annam Motifs",
      description="Peacock blue Kanchipuram silk with woven annam (swan) buttas across the body, mustard contrast border and a traditional temple-tower pallu. 6.2 m with blouse piece.",
      price=11499, mrp=12999, sku="MS-SS-002", stock=4, category="Silk Sarees", hsn="50072010",
      photo="Saree on dress form showing the blue body against the mustard border; second frame flat-lay folded in a fan so the pallu temple pattern is visible. Close-up of one annam butta in natural light."),
 dict(name="Kanchipuram Bridal Silk Saree – Red & Gold Brocade",
      description="Bridal-weight Kanchipuram silk in kumkum red with heavy gold zari brocade pallu, broad double border and zari checks on the body. Comes with a matching blouse piece. 6.2 m.",
      price=12999, mrp=13999, sku="MS-SS-003", stock=3, category="Silk Sarees", hsn="50072010",
      photo="Dress form, three-quarter angle, pallu spread wide to show the full brocade; soft directional light so the zari catches highlights. Detail: macro of the brocade pallu and the double border."),
 dict(name="Arani Soft Silk Saree – Mango Yellow with Temple Border",
      description="Lightweight Arani soft silk in mango yellow with a green temple (gopuram) border and zari-striped pallu. Easy daily or festive wear. 6.2 m with blouse piece.",
      price=3499, mrp=3999, sku="MS-SS-004", stock=12, category="Silk Sarees", hsn="50072010",
      photo="Folded saree stacked with pallu fanned out, top-down on a plain surface; one draped shot on a form. Show the yellow-green contrast clearly."),
 dict(name="Arani Silk Saree – Bottle Green Checks with Zari Butta",
      description="Arani silk in bottle green with self-coloured zari checks and small zari buttas, maroon border and striped pallu. 6.2 m with blouse piece.",
      price=4299, mrp=4899, sku="MS-SS-005", stock=9, category="Silk Sarees", hsn="50072010",
      photo="Draped on a form, front; close-up of the check-and-butta body with the maroon border running diagonally across the frame."),
 dict(name="Mysore Crepe Silk Saree – Blush Pink with Zari Border",
      description="Plain Mysore crepe silk in blush pink with a slim gold zari border and self pallu. Soft fall, light to carry. 6.2 m with running blouse.",
      price=2999, mrp=3499, sku="MS-SS-006", stock=10, category="Silk Sarees", hsn="50072010",
      photo="Saree draped on a form in soft daylight to show the crepe drape; a second frame with the fabric gathered to show texture and the slim zari edge."),
 dict(name="Mysore Crepe Silk Saree – Navy Blue Floral Print",
      description="Printed Mysore crepe silk in navy blue with small cream florals and a plain navy border. 6.2 m with printed blouse piece.",
      price=2699, mrp=3199, sku="MS-SS-007", stock=8, category="Silk Sarees", hsn="50072010",
      photo="Flat-lay with a generous fold of the print filling the frame, plus one draped shot. Keep colour accurate: navy must not read as black."),
 dict(name="Semi-Silk Saree – Rust Orange with Woven Pallu",
      description="Budget-friendly art silk saree in rust orange with a woven zari-look pallu and a narrow black border. 6.2 m with blouse piece. Machine wash gentle.",
      price=1299, mrp=1599, sku="MS-SS-008", stock=20, category="Silk Sarees", hsn="540752",
      photo="Draped on a form; one close-up of the pallu weave. Plain light backdrop."),
 # Cotton Sarees
 dict(name="Chettinad Cotton Saree – Mustard & Black Kandangi Checks",
      description="Handloom Chettinad cotton in the classic kandangi style: mustard body with bold black checks and a broad black border. Crisp, breathable, pre-washed. 6 m with blouse piece.",
      price=1499, mrp=1799, sku="MS-CS-001", stock=15, category="Cotton Sarees", hsn="52084220",
      photo="Draped on a form in bright daylight; detail of the check weave with the broad border. A folded stack of three Chettinad cottons can double as a category banner."),
 dict(name="Chettinad Cotton Saree – Brick Red with Broad Black Border",
      description="Brick red Chettinad handloom cotton with a plain body, 6-inch black border and striped pallu. 6 m with blouse piece.",
      price=1299, mrp=1549, sku="MS-CS-002", stock=14, category="Cotton Sarees", hsn="52084220",
      photo="Draped shot plus a close-up where the red body meets the black border; show the pallu stripes."),
 dict(name="Madurai Sungudi Cotton Saree – Indigo Tie-Dye Dots",
      description="Soft Madurai sungudi cotton in indigo with hand tie-dyed white dots and a zari-line border. Lightweight summer saree. 6 m with blouse piece.",
      price=999, mrp=1199, sku="MS-CS-003", stock=18, category="Cotton Sarees", hsn="52083220",
      photo="Flat-lay with the dotted field filling the frame; one draped shot. Macro of the tie-dye dots so the hand-done irregularity is visible."),
 dict(name="Coimbatore Soft Cotton Saree – Sea Green with Thread Border",
      description="Everyday Coimbatore soft cotton in sea green with a thread-woven border and small pallu stripes. Pre-shrunk. 6 m with blouse piece.",
      price=849, mrp=999, sku="MS-CS-004", stock=22, category="Cotton Sarees", hsn="52083220",
      photo="Draped on a form; simple front view. Detail of the thread border."),
 dict(name="Negamam Handloom Cotton Saree – Off-White with Maroon Border",
      description="Negamam handloom cotton in off-white with a maroon temple border and maroon-gold pallu. Fine count, soft hand feel. 6 m with blouse piece.",
      price=1199, mrp=1399, sku="MS-CS-005", stock=11, category="Cotton Sarees", hsn="52084220",
      photo="Draped shot against a darker backdrop so the off-white body reads clearly; close-up of the maroon temple border."),
 # Veshti & Angavastram
 dict(name="Cotton Veshti (Dhoti) – 4 Muzham, 1-inch Gold Zari Border",
      description="Bleached white cotton veshti, 4 muzham (single), with a 1-inch gold zari border. Soft finish, suitable for daily and temple wear.",
      price=499, mrp=599, sku="MS-VA-001", stock=40, category="Veshti & Angavastram", hsn="52082110",
      photo="Neatly folded veshti with the zari border on top, flat-lay on a plain surface; second frame worn on a model (waist-down crop is fine)."),
 dict(name="Cotton Veshti & Angavastram Set – 8 Muzham, Green Border",
      description="Double (8 muzham) white cotton veshti with a matching angavastram, both with a green and gold border. Ideal for weddings and functions.",
      price=899, mrp=1049, sku="MS-VA-002", stock=25, category="Veshti & Angavastram", hsn="52082110",
      photo="Veshti and angavastram folded side by side showing the matching green border; one shot worn with the angavastram over the shoulder."),
 dict(name="Pure Silk Veshti (Pattu Veshti) with Angavastram – Cream & Gold",
      description="Pure silk pattu veshti in cream with a broad gold zari border, paired with a matching silk angavastram. 8 muzham. Dry clean only.",
      price=4999, mrp=5799, sku="MS-VA-003", stock=5, category="Veshti & Angavastram", hsn="500720",
      photo="Folded set with the zari border fanned; soft side light to show silk sheen. A worn shot on a model is strongly preferred for this price point."),
 dict(name="Silk Angavastram (Shoulder Cloth) – Maroon with Zari Border",
      description="Maroon silk angavastram (thundu) with a gold zari border, worn over the shoulder with a veshti. Approx. 2.5 m.",
      price=1499, mrp=1799, sku="MS-VA-004", stock=12, category="Veshti & Angavastram", hsn="621410",
      photo="Angavastram folded lengthwise with the border visible, flat-lay; optional shot draped over a shoulder."),
 # Kids Wear
 dict(name="Girls' Pattu Pavadai Set – Pink & Green, Age 2–3",
      description="Traditional pattu pavadai (silk skirt) and blouse for girls, pink skirt with green zari border and a matching green blouse. Fully lined, back zip. Age 2–3; other sizes on request.",
      price=1799, mrp=2099, sku="MS-KW-001", stock=8, category="Kids Wear", hsn="620429",
      photo="Full outfit laid flat as worn (blouse above skirt) on a plain background; or on a child mannequin. Detail of the zari border and blouse neckline. No child faces needed."),
 dict(name="Girls' Pattu Pavadai Set – Peacock Blue & Gold, Age 5–6",
      description="Peacock blue pattu pavadai with a broad gold zari border and a gold tissue blouse with puff sleeves. Fully lined. Age 5–6; other sizes on request.",
      price=2199, mrp=2499, sku="MS-KW-002", stock=6, category="Kids Wear", hsn="620429",
      photo="Flat-lay of the full set with the skirt fanned to show the border; close-up of the tissue blouse sleeve."),
 dict(name="Boys' Veshti Sattai Set – White with Red Border, Age 3–4",
      description="Boys' readymade cotton veshti with elastic waist and a matching half-sleeve shirt, white with a red border. Age 3–4; other sizes on request.",
      price=899, mrp=1049, sku="MS-KW-003", stock=10, category="Kids Wear", hsn="620322",
      photo="Shirt and veshti laid flat as an outfit; show the elastic waistband in a detail shot (parents look for it)."),
 dict(name="Girls' Cotton Frock – Chettinad Checks, Yellow, Age 4–5",
      description="Sleeveless A-line frock stitched from yellow Chettinad check cotton with a contrast black bias trim. Age 4–5; other sizes on request.",
      price=699, mrp=799, sku="MS-KW-004", stock=14, category="Kids Wear", hsn="620442",
      photo="Frock on a hanger or child mannequin, front view; close-up of the check fabric and bias trim."),
 # Readymade & Blouses
 dict(name="Readymade Silk Blouse – Gold Tissue, Elbow Sleeve",
      description="Gold tissue silk blouse with elbow sleeves, round neck, back hook closure and cotton lining. Pairs with most Kanchipuram sarees. Sizes 34–40.",
      price=1299, mrp=1499, sku="MS-RB-001", stock=16, category="Readymade & Blouses", hsn="620610",
      photo="Blouse on a half-bust form, front and back; show the hook closure. Even, soft light so the tissue sheen is visible without blowing out."),
 dict(name="Readymade Cotton Blouse – Black with Maroon Piping",
      description="Black cotton blouse with maroon piping on the neck and sleeves, front hooks, short sleeve. Sizes 32–40.",
      price=599, mrp=699, sku="MS-RB-002", stock=24, category="Readymade & Blouses", hsn="620630",
      photo="Blouse on a half-bust form, front view; close-up of the piping detail."),
 dict(name="Men's Cotton Shirt – Half Sleeve, Cream",
      description="Plain cream cotton shirt, regular fit, half sleeve, single chest pocket. Pairs with veshti. Sizes 38–44.",
      price=799, mrp=999, sku="MS-RB-003", stock=20, category="Readymade & Blouses", hsn="620520",
      photo="Shirt on a hanger or torso form, front view, buttoned; a folded shot for the thumbnail."),
 dict(name="Men's Art Silk Jibba (Kurta) – Sandal, Full Sleeve",
      description="Sandal-coloured art silk jibba with full sleeves, mandarin collar and side slits. Festive wear with veshti. Sizes 38–44.",
      price=1699, mrp=1999, sku="MS-RB-004", stock=9, category="Readymade & Blouses", hsn="620530",
      photo="Jibba on a torso form, front view; detail of collar and placket. Worn shot with a veshti would also serve as a homepage banner."),
]

# ---------------------------------------------------------------- Anna Foods
FOODS = [
 # Savouries
 dict(name="Butter Murukku – 250 g",
      description="Crisp rice-and-urad murukku made with butter, fried in groundnut oil. Lightly salted, no colours or preservatives. 250 g resealable pack. Best within 30 days of packing.",
      price=120, mrp=130, sku="AF-SV-001", stock=60, category="Savouries", hsn="21069099",
      photo="Murukku spirals piled in a shallow bowl or on a banana leaf, top-down, with the sealed 250 g pack beside; warm daylight. Macro of one murukku for texture."),
 dict(name="Thattai – 200 g",
      description="Thin, crunchy rice-flour thattai with chana dal, curry leaves and sesame. 200 g pack. Best within 30 days of packing.",
      price=95, mrp=105, sku="AF-SV-002", stock=50, category="Savouries", hsn="21069099",
      photo="Thattai discs fanned on a plate, top-down; show the visible chana dal and curry leaf. Pack in the corner of the frame."),
 dict(name="Madras Mixture – 500 g",
      description="Classic Madras mixture: boondi, omapodi, fried peanuts, curry leaves and cashew bits, medium spice. 500 g pack.",
      price=180, mrp=199, sku="AF-SV-003", stock=45, category="Savouries", hsn="21069099",
      photo="Mixture heaped in a steel bowl with a steel tumbler of filter coffee nearby; top-down. A macro showing all the components."),
 dict(name="Ribbon Pakoda (Ola Pakoda) – 250 g",
      description="Ribbon-shaped besan and rice flour pakoda with a hint of asafoetida and chilli. 250 g pack.",
      price=110, mrp=120, sku="AF-SV-004", stock=40, category="Savouries", hsn="21069099",
      photo="Loose ribbon pakoda tangled in a bowl, 45° angle; pack beside. Natural light."),
 dict(name="Appalam (Urad Papad) – 200 g",
      description="Sun-dried urad dal appalam, plain. Fry or roast. Approx. 40 pieces per 200 g pack.",
      price=65, mrp=75, sku="AF-SV-005", stock=70, category="Savouries", hsn="19059040",
      photo="Stack of raw appalam with two or three fried ones on top to show the puffed result; top-down on a plain surface."),
 # Sweets
 dict(name="Ghee Mysore Pak – 500 g",
      description="Soft, porous Mysore pak made with pure cow ghee, besan and sugar. Cut into 20 pieces. 500 g box. Best within 10 days of packing.",
      price=320, mrp=350, sku="AF-SW-001", stock=30, category="Sweets", hsn="21069099",
      photo="Mysore pak pieces stacked in the open box plus two pieces on a small plate, one broken to show the porous inside; soft window light."),
 dict(name="Adhirasam – Pack of 10",
      description="Traditional adhirasam made from rice flour, jaggery and cardamom, fried in ghee-oil blend. Pack of 10. Best within 7 days of packing.",
      price=180, mrp=200, sku="AF-SW-002", stock=25, category="Sweets", hsn="21069099",
      photo="Adhirasam stacked on a banana leaf, 45° angle, one broken to show the inside; dark brown must not look burnt, so use diffused light."),
 dict(name="Tirunelveli Wheat Halwa – 500 g",
      description="Glossy wheat halwa in the Tirunelveli style, slow-cooked with ghee and sugar, with cashew. 500 g box. Store cool; best within 15 days.",
      price=260, mrp=290, sku="AF-SW-003", stock=20, category="Sweets", hsn="21069099",
      photo="Halwa in the box with a spoon lifting a glossy portion; show the sheen and cashew pieces. Close-up only, no wide table."),
 dict(name="Kovilpatti Kadalai Mittai (Peanut Chikki) – 250 g",
      description="Peanut and jaggery chikki in the Kovilpatti style, cut into bars. No refined sugar. 250 g pack.",
      price=90, mrp=100, sku="AF-SW-004", stock=55, category="Sweets", hsn="170490",
      photo="Chikki bars stacked with one snapped in half to show whole peanuts; top-down with the pack."),
 dict(name="Boondi Laddu – Pack of 12",
      description="Ghee boondi laddu with cashew, raisins and cardamom, approx. 40 g each. Pack of 12. Best within 10 days of packing.",
      price=220, mrp=240, sku="AF-SW-005", stock=30, category="Sweets", hsn="21069099",
      photo="Laddus arranged in the pack tray with one cut open on a plate to show boondi texture; warm light."),
 dict(name="Karupatti (Palm Jaggery) – 500 g",
      description="Pure palmyra palm jaggery (karupatti) in traditional cup moulds, unrefined. Use for coffee, payasam and sweets. 500 g.",
      price=150, mrp=165, sku="AF-SW-006", stock=40, category="Sweets", hsn="17029010",
      photo="Whole karupatti cups piled with a few shards, top-down on a plain or cloth background; show the dark, slightly matte surface."),
 # Spices & Masalas
 dict(name="Sambar Powder – 200 g",
      description="Home-style sambar powder: roasted coriander, red chilli, toor dal, fenugreek, pepper and curry leaves, ground fresh in small batches. 200 g pack.",
      price=95, mrp=105, sku="AF-SP-001", stock=80, category="Spices & Masalas", hsn="09109100",
      photo="Powder in a small steel bowl with the whole roasted ingredients arranged around it; top-down. Pack in frame."),
 dict(name="Rasam Powder – 200 g",
      description="Pepper-forward rasam powder with cumin, coriander, red chilli and toor dal. 200 g pack.",
      price=90, mrp=100, sku="AF-SP-002", stock=75, category="Spices & Masalas", hsn="09109100",
      photo="Same styling as sambar powder for consistency: bowl of powder plus whole pepper and cumin around it; top-down."),
 dict(name="Ramnad Mundu Chilli Powder – 200 g",
      description="Ground from round Ramnad mundu chillies, known for deep red colour and moderate heat. No added colour. 200 g pack.",
      price=110, mrp=120, sku="AF-SP-003", stock=60, category="Spices & Masalas", hsn="09042211",
      photo="Chilli powder heaped beside a handful of whole round mundu chillies; top-down, true red colour."),
 dict(name="Erode Turmeric Powder – 100 g",
      description="Single-origin Erode turmeric, ground from whole fingers. Bright colour, strong aroma. 100 g pack.",
      price=45, mrp=50, sku="AF-SP-004", stock=90, category="Spices & Masalas", hsn="09103030",
      photo="Turmeric powder with two or three whole dried turmeric fingers; top-down. Watch white balance so the yellow is not orange."),
 dict(name="Kolli Hills Black Pepper (Whole) – 100 g",
      description="Bold, sun-dried black pepper from the Kolli Hills, whole. 100 g pack.",
      price=160, mrp=175, sku="AF-SP-005", stock=50, category="Spices & Masalas", hsn="09041130",
      photo="Whole peppercorns in a wooden scoop or on a banana leaf, macro, with a few cracked; pack behind."),
 # Pickles & Podis
 dict(name="Avakkai Mango Pickle – 400 g",
      description="Raw mango avakkai in gingelly oil with mustard, red chilli and fenugreek. Spicy. 400 g glass jar. Keep refrigerated after opening.",
      price=190, mrp=210, sku="AF-PK-001", stock=35, category="Pickles & Podis", hsn="20019000",
      photo="Open glass jar with pickle visible, plus a spoonful on a small plate beside curd rice; 45° angle, warm light."),
 dict(name="Lime Pickle (Elumichai Oorugai) – 300 g",
      description="Whole lime pieces cured in salt and chilli, in gingelly oil, mild-hot. 300 g glass jar.",
      price=140, mrp=155, sku="AF-PK-002", stock=35, category="Pickles & Podis", hsn="20019000",
      photo="Open jar plus a small bowl of pickle showing lime pieces; same angle and light as the avakkai shot."),
 dict(name="Idli Milagai Podi (Gunpowder) – 200 g",
      description="Roasted urad, chana dal, red chilli and sesame ground coarse; mix with gingelly oil for idli and dosa. 200 g pack.",
      price=120, mrp=130, sku="AF-PK-003", stock=60, category="Pickles & Podis", hsn="21069099",
      photo="Podi in a small bowl with a well of gingelly oil in the centre, two idlis beside; top-down."),
 # Millets & Rice
 dict(name="Ragi (Finger Millet) Whole – 1 kg",
      description="Cleaned whole ragi grain, unpolished. For koozh, dosai, malt and porridge. 1 kg pack.",
      price=85, mrp=95, sku="AF-ML-001", stock=50, category="Millets & Rice", hsn="10082930",
      photo="Ragi grains in a bowl or poured onto a plain surface with the pack; macro showing grain colour and size."),
 dict(name="Thinai (Foxtail Millet) – 1 kg",
      description="Dehusked foxtail millet (thinai), ready to cook like rice or for upma and pongal. 1 kg pack.",
      price=140, mrp=155, sku="AF-ML-002", stock=40, category="Millets & Rice", hsn="10082990",
      photo="Millet in a bowl with the pack behind; keep styling identical across all millet products for a tidy grid."),
 dict(name="Kambu (Pearl Millet) – 1 kg",
      description="Whole pearl millet (kambu/bajra), cleaned, for koozh, dosai and rotis. 1 kg pack.",
      price=70, mrp=80, sku="AF-ML-003", stock=45, category="Millets & Rice", hsn="10082920",
      photo="Same styling as ragi and thinai: grain in a bowl plus pack; macro of grains."),
 # Oils & Coffee
 dict(name="Cold-Pressed Gingelly (Sesame) Oil – 2 L",
      description="Chekku (wood-pressed) gingelly oil from black sesame, unrefined and unfiltered. For cooking and oil bath. 2 L food-grade can.",
      price=899, mrp=960, sku="AF-OC-001", stock=20, category="Oils & Coffee", hsn="15155091",
      photo="The sealed 2 L can plus a glass bottle of the amber oil in front, backlit so the colour shows; a small heap of black sesame seeds beside."),
 dict(name="Cold-Pressed Groundnut Oil – 1 L",
      description="Chekku groundnut (peanut) oil, cold-pressed, unrefined, with natural nutty aroma. 1 L bottle.",
      price=399, mrp=430, sku="AF-OC-002", stock=30, category="Oils & Coffee", hsn="15089091",
      photo="The 1 L bottle with a small bowl of raw groundnuts; same lighting setup as the gingelly oil."),
 dict(name="Filter Coffee Powder 80:20 (Coffee–Chicory) – 500 g",
      description="Medium-dark roast Arabica-Robusta blend with 20% chicory, ground for the traditional brass filter. 500 g pack, fresh-roasted to order.",
      price=399, mrp=440, sku="AF-OC-003", stock=40, category="Oils & Coffee", hsn="09019020",
      photo="Coffee powder in the pack with a brass filter and a steel tumbler-davara set, 45° angle, warm light; macro of the grind."),
]

# ---------------------------------------------------------------- Sri Gold Jewels
JEWELS = [
 # Temple Jewellery
 dict(name="Lakshmi Pendant Temple Necklace – Kemp Red & Green, Matte Gold",
      description="Short temple necklace with a Lakshmi pendant, set with red and green kemp stones in a matte gold finish. Brass base, adjustable dori. Length approx. 16–18 in.",
      price=1299, mrp=1599, sku="SGJ-TJ-001", stock=12, category="Temple Jewellery", hsn="71171990",
      photo="Necklace on a black velvet bust, front view; macro of the Lakshmi pendant showing the kemp stones. Avoid harsh flash on the matte finish."),
 dict(name="Kasu Malai (Coin Necklace) – Short, 18 in",
      description="Classic kasu malai with Lakshmi coin charms on a matte gold chain. Brass base, hook clasp with extension. 18 in.",
      price=999, mrp=1199, sku="SGJ-TJ-002", stock=15, category="Temple Jewellery", hsn="71171990",
      photo="Necklace laid in a gentle curve on an ivory surface, top-down; macro of three coins showing the Lakshmi embossing."),
 dict(name="Long Haram with Peacock Pendant – Kemp Stones",
      description="Long temple haram (approx. 28 in) with a peacock pendant set with kemp stones and pearl drops. Matte gold finish on brass, adjustable dori.",
      price=1899, mrp=2299, sku="SGJ-TJ-003", stock=8, category="Temple Jewellery", hsn="71171990",
      photo="Full length on a velvet bust so the proportion is visible; macro of the peacock pendant and pearl drops."),
 dict(name="Oddiyanam (Waist Belt) – Lakshmi Motif, Adjustable",
      description="Temple-style oddiyanam with a central Lakshmi motif, kemp stones and pearl hangings. Fits waist 28–38 in with the adjustable hook chain.",
      price=2199, mrp=2499, sku="SGJ-TJ-004", stock=6, category="Temple Jewellery", hsn="71171990",
      photo="Belt laid flat in a straight line on velvet, top-down; macro of the centre piece; one shot worn over a plain saree pleat (waist crop) to show scale."),
 dict(name="Vanki (Armlet) – Kemp, Pair",
      description="Pair of V-shaped vanki armlets in matte gold with red kemp stones and a tie-back dori. Fits upper arm 9–12 in.",
      price=899, mrp=1099, sku="SGJ-TJ-005", stock=10, category="Temple Jewellery", hsn="71171990",
      photo="Pair side by side on velvet, top-down; one worn shot on an upper arm (arm crop only)."),
 dict(name="Matte Gold Manga Malai (Mango Necklace) – 22 in",
      description="Manga malai with repeated mango motifs set with ruby-red stones, matte gold finish on brass. 22 in, hook clasp.",
      price=1499, mrp=1799, sku="SGJ-TJ-006", stock=9, category="Temple Jewellery", hsn="71171990",
      photo="On a velvet bust, front; macro of three mango motifs."),
 # Bangles
 dict(name="Kemp Stone Bangles – Set of 2",
      description="Pair of matte gold bangles set with red and green kemp stones, temple style. Available in sizes 2.4, 2.6 and 2.8.",
      price=699, mrp=849, sku="SGJ-BG-001", stock=18, category="Bangles", hsn="71171910",
      photo="Both bangles stacked slightly offset on an ivory surface, 45° angle; macro of the stone setting. One worn shot on a wrist."),
 dict(name="Antique Gold Bangles – Set of 4, Kada Style",
      description="Set of four antique-finish bangles with embossed floral pattern. Brass base. Sizes 2.4, 2.6, 2.8.",
      price=549, mrp=649, sku="SGJ-BG-002", stock=20, category="Bangles", hsn="71171910",
      photo="Four bangles fanned in a row, top-down; detail of the embossing."),
 dict(name="Glass Bangles – 12-Piece Set, Maroon & Gold",
      description="Twelve glass bangles, six maroon and six gold-dusted, for daily and festive wear. Sizes 2.4, 2.6, 2.8.",
      price=149, mrp=179, sku="SGJ-BG-003", stock=40, category="Bangles", hsn="70181010",
      photo="Bangles stacked on a bangle stand or in a loose pile, 45° angle, with light catching the glass; one worn stack on a wrist."),
 dict(name="Silk Thread Bangles – Set of 4, Peacock Blue",
      description="Hand-wrapped silk thread bangles in peacock blue with gold bead and stone-chain accents. Set of 4. Sizes 2.4, 2.6, 2.8.",
      price=299, mrp=349, sku="SGJ-BG-004", stock=25, category="Bangles", hsn="71179090",
      photo="Set stacked at an angle on ivory, 45°; macro of the thread wrap and bead accent."),
 dict(name="Pearl Kada – Single, Openable",
      description="Openable brass kada with a double row of imitation pearls and a matte gold frame. One size fits most with the screw clasp.",
      price=799, mrp=949, sku="SGJ-BG-005", stock=12, category="Bangles", hsn="71171990",
      photo="Kada standing on edge on velvet, front; detail of the clasp; one worn shot."),
 # Earrings
 dict(name="Kemp Jhumkas – Matte Gold with Pearl Drops",
      description="Medium temple jhumkas with red kemp studs, matte gold bells and pearl drops. Push-back posts. Drop approx. 5 cm.",
      price=449, mrp=549, sku="SGJ-ER-001", stock=30, category="Earrings", hsn="71171990",
      photo="Pair hanging from an earring stand on ivory, front; macro of the bell and pearl drops; one worn ear-crop shot."),
 dict(name="Peacock Jhumkas – Green Meenakari",
      description="Peacock-motif jhumkas with green and blue meenakari enamel and small pearl hangings. Push-back posts. Drop approx. 5.5 cm.",
      price=399, mrp=499, sku="SGJ-ER-002", stock=28, category="Earrings", hsn="71171990",
      photo="Pair on an earring stand; macro of the enamel work so the colours are accurate."),
 dict(name="Lakshmi Studs – Small, Daily Wear",
      description="Small Lakshmi coin studs in matte gold finish, approx. 1.2 cm, push-back posts.",
      price=199, mrp=249, sku="SGJ-ER-003", stock=50, category="Earrings", hsn="71171990",
      photo="Pair on a plain ivory surface with a coin or ruler for scale in one frame; macro front view."),
 dict(name="Chandbali Earrings – Ruby Red AD Stones",
      description="Crescent chandbali earrings set with ruby-red and white AD (American diamond) stones and pearl drops. Push-back posts. Drop approx. 6 cm.",
      price=549, mrp=649, sku="SGJ-ER-004", stock=20, category="Earrings", hsn="71171990",
      photo="Pair on an earring stand, soft directional light for stone sparkle; one worn ear-crop shot."),
 dict(name="Jimikki with Maatal (Ear Chain) – Pearl",
      description="Pearl jimikki earrings with detachable pearl maatal ear chains that hook into the hair. Matte gold finish. Push-back posts.",
      price=649, mrp=799, sku="SGJ-ER-005", stock=15, category="Earrings", hsn="71171990",
      photo="One earring with the maatal chain extended, laid on velvet; one worn shot showing how the chain sits from ear to hair."),
 # Bridal Sets
 dict(name="Bridal Temple Jewellery Set – Necklace, Haram, Jhumkas, Maang Tikka",
      description="Four-piece bridal temple set: short Lakshmi necklace, long kemp haram, matching jhumkas and maang tikka. Matte gold on brass, kemp stones and pearls. Comes in a gift box.",
      price=2499, mrp=2999, sku="SGJ-BS-001", stock=5, category="Bridal Sets", hsn="71171990",
      photo="Full set on a velvet bust (necklace and haram layered, tikka on the forehead area); a second flat-lay of all four pieces arranged in the box."),
 dict(name="Guttapusalu-style Pearl Choker Set with Earrings",
      description="Choker made of clustered imitation pearl bunches on a matte gold frame with ruby-red stone centres, with matching earrings. Adjustable dori.",
      price=1799, mrp=2199, sku="SGJ-BS-002", stock=6, category="Bridal Sets", hsn="71179010",
      photo="Choker and earrings on a velvet bust; macro of the pearl clusters."),
 dict(name="AD Stone Choker Set with Earrings – White",
      description="White AD (American diamond) stone choker with a drop pendant and matching earrings, rhodium finish. Adjustable dori.",
      price=1499, mrp=1799, sku="SGJ-BS-003", stock=8, category="Bridal Sets", hsn="71171990",
      photo="Set on a dark velvet bust so the white stones read clearly; soft directional light; macro of the pendant."),
 dict(name="Manga Malai & Jhumka Set – Ruby Red",
      description="Ruby-red manga malai (22 in) with matching kemp jhumkas, matte gold finish. Hook clasp with extension.",
      price=1999, mrp=2399, sku="SGJ-BS-004", stock=7, category="Bridal Sets", hsn="71171990",
      photo="Set on a velvet bust, front; flat-lay of the necklace coiled with jhumkas in the centre."),
 # Hair & Accessories
 dict(name="Jadai Billai (Braid Ornament) – 9-Piece Set",
      description="Nine-piece bridal braid ornament set with Lakshmi and star motifs, kemp stones and pearl drops, on hook pins. Matte gold finish.",
      price=899, mrp=1099, sku="SGJ-HA-001", stock=8, category="Hair & Accessories", hsn="961590",
      photo="All nine pieces laid in braid order (largest at top) on velvet, top-down; one worn shot on a plaited braid from behind."),
 dict(name="Maang Tikka (Nethichutti) – Kemp, Matte Gold",
      description="Kemp stone maang tikka with a round pendant and pearl edge on a matte gold chain, hook at the end. Pendant approx. 3 cm.",
      price=349, mrp=429, sku="SGJ-HA-002", stock=20, category="Hair & Accessories", hsn="71171990",
      photo="Tikka laid straight on velvet showing chain and pendant; one worn forehead-crop shot."),
 dict(name="Jadai Kunjalam (Braid Tassels) – Maroon with Gold Beads",
      description="Three-strand silk thread kunjalam in maroon with gold bead caps, tied to the end of a braid. Length approx. 20 cm.",
      price=249, mrp=299, sku="SGJ-HA-003", stock=25, category="Hair & Accessories", hsn="580890",
      photo="Tassels hanging straight on an ivory background; macro of the bead caps; one worn shot at the braid end."),
 dict(name="Kolusu (Anklets) – Silver-Plated Brass, Pair with Ghungroo",
      description="Pair of silver-plated brass anklets with small ghungroo bells and a hook clasp. Length approx. 10 in.",
      price=399, mrp=499, sku="SGJ-HA-004", stock=22, category="Hair & Accessories", hsn="71171990",
      photo="Pair coiled on velvet, top-down; one worn ankle shot on a plain floor."),
 dict(name="Metti (Toe Rings) – Silver-Plated, Pair",
      description="Pair of adjustable silver-plated brass toe rings with a simple twisted pattern.",
      price=99, mrp=129, sku="SGJ-HA-005", stock=40, category="Hair & Accessories", hsn="71171990",
      photo="Pair on velvet with a coin for scale, top-down; macro of the twisted pattern."),
]

def finalize(rows, prefix):
    out = []
    for r in rows:
        r = dict(r)
        words = slug(r["name"].split(" – ")[0]).split("-")
        short = ""
        for w in words:
            if len(short) + len(w) + 1 > 36: break
            short = f"{short}-{w}" if short else w
        r["image_filename"] = f"{r['sku'].lower()}-{short}.jpg"
        r["hsn_code"] = r.pop("hsn")
        out.append(r)
    return out

STORES = [
 {
  "slug": "meenakshi-silks", "subdomain": "meenakshi-silks", "name": "Meenakshi Silks",
  "catalog_csv": "silks.csv", "products": SILKS,
  "tagline": {"en": "Handwoven silks and cottons from the weaving towns of Tamil Nadu",
              "ta": "தமிழகத்தின் நெசவு ஊர்களிலிருந்து கைத்தறி பட்டும் பருத்தியும்"},
  "about": "Meenakshi Silks is a family-run saree shop in Kanchipuram. We buy directly from weaver families in Kanchipuram, Arani, Karaikudi, Madurai and Negamam, so each saree on this site is the one you will receive: no stock photos, no substitutions. Alongside sarees we stock veshtis, angavastrams, readymade blouses and festive wear for children. Every silk saree ships with its weaver's fold intact; we are happy to send extra photographs or a short video of any piece on request before you order.",
  "address": {"line1": "No. 14, Gandhi Road", "line2": "Near Kamakshi Amman Temple", "city": "Kanchipuram", "district": "Kanchipuram", "state": "Tamil Nadu", "pincode": "631502", "country": "IN"},
  "support_phone": "+91 00000 00001", "whatsapp_number": "+91 00000 00001", "support_email": "hello@meenakshisilks.example",
  "gst_number": None,
  "settings": {"shipping_mode": "free_above", "flat_rate": 99, "free_above": 2999, "cod_enabled": True, "cod_charge": 50, "order_prefix": "MS",
               "dispatch_note": "Ships in 1–2 working days; silks are sent in a cloth bag inside a rigid box.",
               "returns_note": "7-day exchange for unused, unwashed items with tags; no exchange on fall-stitched or altered sarees."},
  "theme": {"layout_variant": "V1", "layout_notes": "Classic layout: full-width hero banner, category tiles, product grid 3-up on desktop. Suits a heritage saree store.",
            "palette_id": "arakku-gold", "primary_color": "#7B1E2B", "secondary_color": "#C9A227", "background": "#FBF7F0", "text": "#2B1D1F",
            "font_pair_id": "playfair-lato", "fonts": {"heading": "Playfair Display", "body": "Lato"},
            "header_style": "centered-logo", "card_style": "portrait-image",
            "homepage_sections": ["hero", "categories", "featured-products", "about-strip"]},
  "categories": ["Silk Sarees", "Cotton Sarees", "Veshti & Angavastram", "Kids Wear", "Readymade & Blouses"],
 },
 {
  "slug": "anna-foods", "subdomain": "anna-foods", "name": "Anna Foods",
  "catalog_csv": "foods.csv", "products": FOODS,
  "tagline": {"en": "Home-style snacks, sweets and spices from Madurai",
              "ta": "மதுரையின் வீட்டுச் சுவை: பலகாரம், இனிப்பு, மசாலா"},
  "about": "Anna Foods makes small-batch snacks, sweets, spice powders and pickles in Madurai using the recipes our kitchen has always used. Savouries are fried in groundnut oil, sweets are made with cow ghee, and masalas are roasted and ground the week they ship. We also pack millets, cold-pressed oils and filter coffee from producers we know by name. Everything is labelled with the packing date and a best-before window; we ship within Tamil Nadu and across India.",
  "address": {"line1": "No. 27, West Masi Street", "line2": "", "city": "Madurai", "district": "Madurai", "state": "Tamil Nadu", "pincode": "625001", "country": "IN"},
  "support_phone": "+91 00000 00002", "whatsapp_number": "+91 00000 00002", "support_email": "orders@annafoods.example",
  "gst_number": None, "fssai_license": None,
  "settings": {"shipping_mode": "free_above", "flat_rate": 60, "free_above": 999, "cod_enabled": True, "cod_charge": 30, "order_prefix": "AF",
               "dispatch_note": "Snacks and masalas ship same or next working day; fresh sweets (Mysore pak, adhirasam, laddu, halwa) are made to order and dispatched Monday–Thursday only.",
               "returns_note": "Food items cannot be returned; damaged or leaking parcels are replaced if reported with photos within 48 hours of delivery."},
  "theme": {"layout_variant": "V2", "layout_notes": "Grid-first layout: compact header with search, horizontal category chips, dense 4-up product grid with pack size visible. Suits a grocery/snacks store with many low-ticket items.",
            "palette_id": "turmeric-leaf", "primary_color": "#2F6B3A", "secondary_color": "#E0A526", "background": "#FFFDF7", "text": "#1F2A1E",
            "font_pair_id": "poppins-nunito", "fonts": {"heading": "Poppins", "body": "Nunito"},
            "header_style": "compact-search", "card_style": "square-image",
            "homepage_sections": ["category-chips", "featured-picks", "featured-products", "trust-strip"]},
  "categories": ["Savouries", "Sweets", "Spices & Masalas", "Pickles & Podis", "Millets & Rice", "Oils & Coffee"],
 },
 {
  "slug": "sri-gold-jewels", "subdomain": "sri-gold-jewels", "name": "Sri Gold Jewels",
  "catalog_csv": "jewels.csv", "products": JEWELS,
  "tagline": {"en": "Temple jewellery and everyday sparkle, without the gold price",
              "ta": "கோவில் நகைகளின் அழகு, தங்க விலை இல்லாமல்"},
  "about": "Sri Gold Jewels sells imitation and gold-plated jewellery from T. Nagar, Chennai: temple sets, kemp and AD stone pieces, bangles, jhumkas and bridal collections. All pieces are brass or copper-alloy based with matte gold, antique or rhodium plating; nothing on this site is real gold or silver, and prices reflect that. Each listing states the base metal, stone type, length and closure so you know exactly what you are buying. Bridal sets can be matched to your saree colour on request.",
  "address": {"line1": "No. 8, Ranganathan Street", "line2": "T. Nagar", "city": "Chennai", "district": "Chennai", "state": "Tamil Nadu", "pincode": "600017", "country": "IN"},
  "support_phone": "+91 00000 00003", "whatsapp_number": "+91 00000 00003", "support_email": "care@srigoldjewels.example",
  "gst_number": None,
  "settings": {"shipping_mode": "free_above", "flat_rate": 49, "free_above": 799, "cod_enabled": True, "cod_charge": 40, "order_prefix": "SGJ",
               "dispatch_note": "Ships in 1–2 working days in a padded jewellery box.",
               "returns_note": "7-day return for unworn items in original packaging; earrings are exchange-only for hygiene reasons."},
  "theme": {"layout_variant": "V3", "layout_notes": "Editorial layout: split hero (image + text), large 2-up/3-up product cards on dark or ivory background, sticky add-to-cart on product page. Suits jewellery where the photo sells.",
            "palette_id": "ivory-rosegold", "primary_color": "#1F1A17", "secondary_color": "#B76E79", "background": "#F8F3EE", "text": "#1F1A17",
            "font_pair_id": "cormorant-montserrat", "fonts": {"heading": "Cormorant Garamond", "body": "Montserrat"},
            "header_style": "transparent-over-hero", "card_style": "large-square-hover-zoom",
            "homepage_sections": ["split-hero", "collections", "new-arrivals", "bridal-banner"]},
  "categories": ["Temple Jewellery", "Bangles", "Earrings", "Bridal Sets", "Hair & Accessories"],
 },
]

PRICE_BANDS = {"silks.csv": (499, 12999), "foods.csv": (40, 900), "jewels.csv": (99, 2499)}

def validate(store, rows):
    lo, hi = PRICE_BANDS[store["catalog_csv"]]
    assert len(rows) == 25, (store["name"], len(rows))
    skus = [r["sku"] for r in rows]; names = [r["name"] for r in rows]; files = [r["image_filename"] for r in rows]
    assert len(set(skus)) == 25 and len(set(names)) == 25 and len(set(files)) == 25, store["name"]
    for r in rows:
        assert isinstance(r["price"], int) and isinstance(r["mrp"], int) and isinstance(r["stock"], int), r["sku"]
        assert lo <= r["price"] <= hi, (r["sku"], r["price"])
        assert r["mrp"] >= r["price"], r["sku"]
        assert r["category"] in store["categories"], (r["sku"], r["category"])
        assert re.fullmatch(r"\d{4}|\d{6}|\d{8}", r["hsn_code"]), (r["sku"], r["hsn_code"])
        assert r["stock"] > 0 and r["description"] and r["photo"], r["sku"]
        for bad in ("review", "rating", "bestseller", "sold", "testimonial", "★"):
            assert bad not in (r["name"] + r["description"]).lower(), (r["sku"], bad)
    used = {r["category"] for r in rows}
    assert used == set(store["categories"]), (store["name"], used ^ set(store["categories"]))

def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in COLUMNS})

def write_stores_json(path):
    out = []
    for s in STORES:
        d = {k: v for k, v in s.items() if k != "products"}
        d["product_count"] = len(s["products"])
        d["demo_notice"] = "Fictional business. Address, phone, email and GST are placeholders; replace before any public use."
        out.append(d)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "currency": "INR", "stores": out}, f, ensure_ascii=False, indent=2)
        f.write("\n")

def write_image_list(path, data):
    L = []
    L.append("# Image shopping list for the BMStore demo stores\n")
    L.append("One row per product. The **primary** file name is what the CSV `image_filename` column points to; shoot extra angles as `-2.jpg`, `-3.jpg` with the same stem (e.g. `ms-ss-001-…-2.jpg`). 75 primary images in total.\n")
    L.append("## Shooting / sourcing rules that apply to every photo\n")
    L.append("- **Format:** JPEG, sRGB, long edge at least 2000 px; crop the primary image to a 1:1 square (the storefront card) and keep a 4:5 version if you can (product page).")
    L.append("- **Backgrounds:** Meenakshi Silks on ivory or warm grey seamless paper; Anna Foods on a light wood or plain cream surface, top-down for packs; Sri Gold Jewels on black velvet (sets, necklaces) or ivory card (small items). Keep each store consistent so the grid looks like one shop.")
    L.append("- **Light:** window daylight or a single softbox from the side; no on-camera flash (kills zari and plating). Use a grey card once per session so colours are true; saree and stone colours sell the product.")
    L.append("- **Scale:** for small items (studs, toe rings, spice packs) include one frame with a coin, ruler or hand for scale.")
    L.append("- **People:** worn shots are optional and faces are never required (ear, wrist, waist, braid, shoulder crops are enough). If you photograph a person or a child, get written consent.")
    L.append("- **Sourcing instead of shooting:** only use images you have the rights to (your own, the supplier's with permission, or a licence). Do not scrape marketplace listings. Stock photos are acceptable as a stopgap for a demo only if the product shown matches the listing (same colour, same style).")
    L.append("- **Nothing to fake:** no overlaid badges, star ratings, 'bestseller' ribbons or 'X sold' stickers on images.\n")
    for s, rows in data:
        L.append(f"## {s['name']} ({s['catalog_csv']}, {len(rows)} products)\n")
        cat = None
        for r in rows:
            if r["category"] != cat:
                cat = r["category"]; L.append(f"### {cat}\n")
            L.append(f"**{r['sku']} · {r['name']}**  ")
            L.append(f"File: `{r['image_filename']}`  ")
            L.append(f"Shot: {r['photo']}\n")
    L.append("## Store-level images (not in the CSVs)\n")
    L.append("- `meenakshi-silks-hero.jpg` (2400×1000): a loom or a stack of folded Kanchipuram silks with borders fanned, warm light, room for headline text on the left third.")
    L.append("- `meenakshi-silks-logo.png` (square, transparent): wordmark; a simple temple-gopuram or lamp mark works with the arakku/gold palette.")
    L.append("- `anna-foods-hero.jpg` (2400×1000): a spread of murukku, mixture, laddu and a brass coffee filter on a banana leaf, top-down, with negative space for text.")
    L.append("- `anna-foods-logo.png`: wordmark; leaf or steel tumbler mark.")
    L.append("- `sri-gold-jewels-hero.jpg` (2400×1200, split-hero crop): bridal temple set on a velvet bust, dark background, lit from one side.")
    L.append("- `sri-gold-jewels-logo.png`: wordmark in Cormorant Garamond; small lotus or kolam mark.")
    L.append("- One category tile per category (square, 1200×1200): reuse the best product photo from that category rather than shooting separately.\n")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

def main():
    data = []
    for s in STORES:
        rows = finalize(s["products"], s["slug"])
        validate(s, rows)
        write_csv(os.path.join(HERE, s["catalog_csv"]), rows)
        data.append((s, rows))
    write_stores_json(os.path.join(HERE, "stores.json"))
    write_image_list(os.path.join(HERE, "IMAGE_SHOPPING_LIST.md"), data)
    for s, rows in data:
        p = [r["price"] for r in rows]
        print(f"{s['catalog_csv']}: {len(rows)} rows, price {min(p)}–{max(p)}, median {int(statistics.median(p))}, categories {len(s['categories'])}, stock {sum(r['stock'] for r in rows)} units")

if __name__ == "__main__":
    main()
