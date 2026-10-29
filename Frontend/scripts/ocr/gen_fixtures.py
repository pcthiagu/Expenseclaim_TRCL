"""Generates synthetic bill images/PDF + expected.json for OCR parser tests. Synthetic: NOT a substitute for real phone photos."""
import json, random, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'tests', 'fixtures', 'receipts')
os.makedirs(OUT, exist_ok=True)
F = '/usr/share/fonts/truetype/dejavu/'
def font(sz, bold=False, mono=False):
    return ImageFont.truetype(F + ('DejaVuSansMono' if mono else 'DejaVuSans') + ('-Bold' if bold else '') + '.ttf', sz)

def render(name, lines, w=600, fmt='png', rotate=0, noise=False, mono=False, scale=1.0):
    pad = 24; y = pad; items = []
    for text, sz, bold, align in lines:
        f = font(int(sz * scale), bold, mono); items.append((text, f, y, align)); y += int(sz * scale * 1.55)
    img = Image.new('RGB', (int(w * scale), y + pad), 'white'); d = ImageDraw.Draw(img)
    for text, f, yy, align in items:
        tw = d.textlength(text, font=f)
        x = (img.width - tw) / 2 if align == 'c' else (img.width - tw - pad if align == 'r' else pad)
        d.text((x, yy), text, font=f, fill=(20, 20, 20))
    if rotate: img = img.rotate(rotate, expand=True, fillcolor='white')
    if noise:
        px = img.load(); random.seed(7)
        for _ in range(img.width * img.height // 40): px[random.randrange(img.width), random.randrange(img.height)] = (random.randrange(90, 200),) * 3
        img = img.filter(ImageFilter.GaussianBlur(0.6))
    path = os.path.join(OUT, f'{name}.{fmt}')
    img.save(path, 'JPEG' if fmt == 'jpg' else 'PNG', **({'quality': 70} if fmt == 'jpg' else {}))
    return path

L = lambda t, s=20, b=False, a='l': (t, s, b, a)
spec = {}
spec['restaurant'] = (dict(lines=[L('SARAVANA BHAVAN', 30, True, 'c'), L('Adyar, Chennai - 600020', 17, False, 'c'), L('GSTIN: 33AAACS1234F1Z5', 17, False, 'c'), L(''),
  L('Bill No: 4471', 21), L('Date: 21/09/2026   Time: 13:42', 21), L(''), L('Masala Dosa x2          120.00'), L('Filter Coffee x2         40.00'), L('Sub Total               160.00'), L('CGST 2.5%                 4.00'), L('SGST 2.5%                 4.00'), L('GRAND TOTAL            168.00', 24, True), L('Thank you! Visit again', 18, False, 'c')], mono=True),
  dict(date='2026-09-21', billerName='SARAVANA BHAVAN', billNumber='4471', amount=168))
spec['fuel'] = (dict(lines=[L('HP PETROL BUNK', 30, True, 'c'), L('NH-48, Sriperumbudur', 17, False, 'c'), L(''), L('Invoice No : HP-21190', 21), L('Date : 30-09-2026', 21), L('Product : MS Petrol'), L('Qty : 35.00 L'), L('Rate : Rs. 104.00 / L'), L('Amount Rs. 3,640.00', 24, True), L('Payment: UPI', 19)]),
  dict(date='2026-09-30', billerName='HP PETROL BUNK', billNumber='HP-21190', amount=3640))
spec['pharmacy'] = (dict(lines=[L('APOLLO PHARMACY', 30, True, 'c'), L('T. Nagar, Chennai', 17, False, 'c'), L(''), L('Bill No: AP-77310', 21), L('Bill Date: 09 Oct 2026', 21), L('Dr. Rx: Meenakshi'), L('Medicines                 700.00'), L('Discount                   60.00'), L('Total  Rs 640.00', 24, True)]),
  dict(date='2026-10-09', billerName='APOLLO PHARMACY', billNumber='AP-77310', amount=640))
spec['cab'] = (dict(lines=[L('Uber India Systems Pvt Ltd', 26, True, 'c'), L('Trip Receipt', 20, False, 'c'), L(''), L('Invoice No: UB-88124', 21), L('Date: 5 Oct 2026', 21), L('Trip fare               390.00'), L('Booking fee              20.00'), L('Total INR 410.00', 24, True), L('Paid via Cash', 19)]),
  dict(date='2026-10-05', billerName='Uber India Systems Pvt Ltd', billNumber='UB-88124', amount=410))
spec['hotel'] = (dict(lines=[L('LEMON TREE HOTEL', 30, True, 'c'), L('Whitefield, Bengaluru', 17, False, 'c'), L('TAX INVOICE', 20, True, 'c'), L(''), L('Invoice No: LT-2026-11890', 21), L('Invoice Date: 25/09/2026', 21), L('Room charges           5,000.00'), L('CGST 6%                  300.00'), L('SGST 6%                  300.00'), L('Net Payable          Rs 1,05,600.00'.replace('1,05,600.00','5,600.00'), 24, True)], mono=True),
  dict(date='2026-09-25', billerName='LEMON TREE HOTEL', billNumber='LT-2026-11890', amount=5600))
spec['lab'] = (dict(lines=[L('APOLLO DIAGNOSTICS', 30, True, 'c'), L(''), L('Bill No. AD-55821', 21), L('Date 10/08/2026', 21), L('Full blood panel         2,400.00'), L('Discount                 200.00'), L('Amount Payable : 2,200.00', 23, True)]),
  dict(date='2026-08-10', billerName='APOLLO DIAGNOSTICS', billNumber='AD-55821', amount=2200))
spec['restaurant_noisy'] = (dict(lines=[L('TRUFFLES', 32, True, 'c'), L('Koramangala, Bengaluru', 17, False, 'c'), L(''), L('Bill No: TR-88213', 21), L('Date: 23-09-2026', 21), L('Burger                  320.00'), L('Service charge            0.00'), L('Total Amount           420.00', 24, True)], noise=True, rotate=2, scale=1.4),
  dict(date='2026-09-23', billerName='TRUFFLES', billNumber='TR-88213', amount=420))
spec['train'] = (dict(lines=[L('IRCTC e-Ticket', 30, True, 'c'), L(''), L('PNR: 4412098765', 21), L('Date of Journey: 23-Sep-2026', 21), L('Chennai Central - Bengaluru City'), L('Ticket Fare           2,350.00'), L('Reservation Charges     100.00'), L('Total Fare Rs 2450.00', 24, True)]),
  dict(date='2026-09-23', billerName='IRCTC e-Ticket', billNumber='4412098765', amount=2450))
expected = {}
for name, (kw, exp) in spec.items():
    render(name, **kw); expected[name + '.png'] = exp
# a JPG variant and a text-layer PDF
render('pharmacy_jpg', **spec['pharmacy'][0], fmt='jpg'); expected['pharmacy_jpg.jpg'] = spec['pharmacy'][1]
img = Image.open(os.path.join(OUT, 'restaurant.png')).convert('RGB'); img.save(os.path.join(OUT, 'restaurant_scan.pdf'), 'PDF', resolution=150)
expected['restaurant_scan.pdf'] = spec['restaurant'][1]
json.dump(expected, open(os.path.join(OUT, 'expected.json'), 'w'), indent=1)
print(len(expected), 'fixtures')
