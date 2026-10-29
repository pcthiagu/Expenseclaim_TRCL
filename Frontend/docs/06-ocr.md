# Bill reading (OCR)

Used in the **Receipt box** (every uploaded bill) and for **bills attached to a claim line or a date-wise cell**. It only ever *suggests*: it fills fields that are still blank, says which ones, and asks the user to check them. It never overwrites what was typed (even text typed but not yet saved), and a failure never blocks the user.

| Mode (`VITE_OCR_MODE`) | How | Notes |
|---|---|---|
| `browser` (default) | Tesseract.js (+ PDF.js for PDFs) in the user's browser | Bills never leave the machine. Assets load lazily; self-host them for an intranet (`VITE_OCR_ASSETS_BASE`: worker, core wasm, `eng.traineddata`). **Not run in the authoring sandbox: test on a real build.** |
| `remote` | `POST` multipart `file` to `VITE_OCR_ENDPOINT` → `{ "text": "..." }` (or `{success,data:{text}}`) | Use your own server (e.g. Tesseract, Azure/AWS/Google OCR). The endpoint must authorise the caller and not log bills. Tested against a real HTTP server running Tesseract. |
| `off` | none | Uploads work as before. |

Fields read: bill **date** (day-first, real calendar date, not in the future), **biller name**, **bill number**, **amount** (labelled grand total, else largest two-decimal figure, marked low confidence). Several bills on one line: amounts add up and bill numbers join only while the field still holds the OCR value.

Accuracy: tested on 10 synthetic bills (restaurant, fuel, pharmacy, cab, hotel, lab, rail e-ticket; PNG, JPG, noisy+rotated, scanned PDF) plus adversarial text cases. **Real phone photos will be harder and accuracy on your bills is unmeasured.** Measure it before relying on it.

## Real-bill result (first test on the owner's machine, browser engine)
Three real bills: one read date, biller and amount (no bill number); one read biller and amount (no date, no bill number); one read nothing. The browser engine therefore runs, and real-image accuracy is partial.

Change made in response: a **second pass** on an upscaled, grayscale, contrast-stretched copy, run only when the first pass left the date, bill number or amount unread; each field is taken from the first pass that found it. On degraded synthetic bills this raised bill-number reads from 3/9 to 5/9 and, on very small images, amount reads from 2/9 to 5/9, while keeping date and amount at 8/9 on moderately small images. It can also produce wrong values on very poor images, so every suggestion is still shown for checking. **This second pass has not been run in a browser yet.**

To tune further I need the raw text for the bill that read nothing: set `VITE_OCR_DEBUG=true` (development only; bills are confidential), upload it, and send me the `[ocr]` console lines (blank out personal data).
