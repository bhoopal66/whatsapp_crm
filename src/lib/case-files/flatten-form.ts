/**
 * A fillable PDF's values as page content. `copyPages` leaves the form
 * behind, and a value with no stored appearance (the reader was expected to
 * draw it) then shows as a blank field in the bundle the bank receives.
 *
 * Throws when a value cannot be drawn (e.g. Arabic text with no stored
 * appearance: the standard fonts have no Arabic); the caller refuses the
 * build rather than send a blank.
 */
import {
  PDFDict,
  PDFName,
  PDFBool,
  PDFCheckBox,
  PDFRadioGroup,
  PDFSignature,
  PDFButton,
  type PDFDocument,
} from 'pdf-lib';

const HIDDEN = 2;
const NO_VIEW = 32;

export function flattenForm(doc: PDFDocument): void {
  if (!doc.catalog.has(PDFName.of('AcroForm'))) return;
  const form = doc.getForm();
  const fields = form.getFields();
  if (fields.length === 0) return;

  // The file says its stored appearances are out of date.
  const stale =
    form.acroForm.dict.lookup(PDFName.of('NeedAppearances')) === PDFBool.True;
  if (stale)
    for (const f of fields)
      if (
        !(f instanceof PDFCheckBox) &&
        !(f instanceof PDFRadioGroup) &&
        !(f instanceof PDFSignature) &&
        !(f instanceof PDFButton)
      )
        form.markFieldAsDirty(f.ref);
  form.updateFieldAppearances();

  // What draws nothing on screen draws nothing here, and pdf-lib refuses a
  // widget with no appearance for its state (an unticked box, an unsigned
  // signature).
  let blank: ReturnType<typeof doc.context.register> | null = null;
  const empty = () =>
    (blank ??= doc.context.register(
      doc.context.formXObject([], { BBox: doc.context.obj([0, 0, 1, 1]) })
    ));
  for (const f of fields)
    for (const w of f.acroField.getWidgets()) {
      const normal = w.getAppearances()?.normal;
      if (!normal || (w.getFlags() & (HIDDEN | NO_VIEW)) !== 0)
        w.setNormalAppearance(empty());
      else if (normal instanceof PDFDict && !normal.has(PDFName.of('Off')))
        normal.set(PDFName.of('Off'), empty());
    }
  form.flatten({ updateFieldAppearances: false });
}
