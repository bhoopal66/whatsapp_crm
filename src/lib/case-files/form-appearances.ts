/**
 * The values of a fillable PDF, before `copyPages`. It copies each page's
 * widget annotations with their stored appearances, which readers draw with
 * or without a form, but not the form itself: a value the reader was expected
 * to draw (no appearance, or `NeedAppearances`) would be a blank field in the
 * bundle the bank receives. Only those get an appearance here.
 *
 * Nothing is flattened: pdf-lib's flatten loses ticks (an indirect `N`, `AS`
 * without `V`), misplaces appearances with their own `BBox` or `Matrix`, and
 * throws on fields that are on no page.
 *
 * Throws when a value on a page has no appearance and cannot be drawn (e.g.
 * Arabic: the standard fonts have none); the caller refuses the build rather
 * than send a blank.
 */
import {
  PDFAcroCheckBox,
  PDFAcroComboBox,
  PDFAcroListBox,
  PDFAcroRadioButton,
  PDFAcroText,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  PDFWidgetAnnotation,
  StandardFonts,
  decodePDFRawStream,
  type PDFDocument,
  type PDFFont,
  type PDFObject,
} from 'pdf-lib';

const HIDDEN = 2;
const NO_VIEW = 32;

const PASSWORD = 1 << 13;
const RADIO = 1 << 15;
const PUSH_BUTTON = 1 << 16;
const COMBO = 1 << 17;

const key = (s: string) => PDFName.of(s);
const OFF = key('Off');

/** How to draw a widget's value, and whether it has an appearance already. */
type Todo = { draw: () => void; stored: boolean };

/** False: something in the form could not be read and was left as it was. */
export function drawFormValues(doc: PDFDocument): boolean {
  const acroForm = doc.catalog.lookup(key('AcroForm'));
  if (!acroForm) return true;
  if (!(acroForm instanceof PDFDict)) return false;
  const stale = acroForm.lookup(key('NeedAppearances')) === PDFBool.True;

  let embedded: PDFFont | null = null;
  const font = () =>
    (embedded ??= doc.embedStandardFont(StandardFonts.Helvetica));
  let complete = true;
  // The pages' widgets, not the form's field list: a field on no page shows
  // nothing, and one broken field makes pdf-lib refuse the whole list.
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(key('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      if (dict.lookup(key('Subtype')) !== key('Widget')) continue;
      const own = annots.get(i);
      let todo: Todo | 'unread' | null;
      try {
        todo = readWidget(doc, dict, own instanceof PDFRef ? own : null, font);
      } catch {
        todo = 'unread';
      }
      if (todo === 'unread') complete = false;
      else if (todo && (!todo.stored || stale)) redraw(dict, todo);
    }
  }
  return complete;
}

/** The drawing goes into an `AP` of its own: a stored one may be shared. */
function redraw(widget: PDFDict, todo: Todo): void {
  const AP = key('AP');
  const before = widget.get(AP);
  widget.delete(AP);
  try {
    todo.draw();
  } catch (err) {
    // An out-of-date appearance is better than no case file.
    if (!todo.stored || !before) throw err;
    widget.set(AP, before);
  }
}

/** Null: there is nothing to draw. 'unread': it cannot be told. */
function readWidget(
  doc: PDFDocument,
  dict: PDFDict,
  own: PDFRef | null,
  font: () => PDFFont
): Todo | 'unread' | null {
  const widget = PDFWidgetAnnotation.fromDict(dict);
  if (widget.getFlags() & (HIDDEN | NO_VIEW)) return null;

  const type = inherited(dict, 'FT');
  const ff = inherited(dict, 'Ff');
  const flags = ff instanceof PDFNumber ? ff.asNumber() : 0;
  const value = inherited(dict, 'V');
  const state = dict.lookup(key('AS'));
  const as = state instanceof PDFName ? state : null;
  const normal = normalAppearance(dict);

  // The field is the widget itself, or its parent when it is one of several.
  const parent = dict.lookup(key('Parent'));
  const kid = !dict.has(key('T')) && parent instanceof PDFDict;
  const field = kid ? parent : dict;
  const fieldRef = kid ? dict.get(key('Parent')) : own;
  const ref = fieldRef instanceof PDFRef ? fieldRef : doc.context.nextRef();

  if (type === key('Btn')) {
    if (flags & PUSH_BUTTON) return null;
    if (normal) {
      if (
        !as &&
        value instanceof PDFName &&
        normal instanceof PDFDict &&
        normal.lookup(value) instanceof PDFStream
      )
        widget.setAppearanceState(value);
      return null;
    }
    const on = as ?? (value instanceof PDFName ? value : OFF);
    if (on === OFF || !sized(widget)) return null;
    // The field's value alone does not say which of several boxes is on.
    const kids = field.lookup(key('Kids'));
    if (!as && kids instanceof PDFArray && kids.size() > 1) return 'unread';
    const draw = () => {
      widget.getOnValue = () => on;
      if (flags & RADIO) {
        const acro = PDFAcroRadioButton.fromDict(field, ref);
        acro.getWidgets = () => [widget];
        PDFRadioGroup.of(acro, ref, doc).updateAppearances();
      } else {
        const acro = PDFAcroCheckBox.fromDict(field, ref);
        acro.getWidgets = () => [widget];
        PDFCheckBox.of(acro, ref, doc).updateAppearances();
      }
      widget.setAppearanceState(on);
    };
    return { draw, stored: false };
  }

  const stored =
    normal instanceof PDFDict
      ? as !== null && normal.lookup(as) instanceof PDFStream
      : normal !== null;

  if (type === key('Tx')) {
    // A reader shows a password as asterisks: nothing to lose.
    if (flags & PASSWORD) return null;
    const text = textOf(value);
    if (!text?.trim() || !sized(widget)) return null;
    const draw = () => {
      const acro = PDFAcroText.fromDict(field, ref);
      acro.getWidgets = () => [widget];
      const f = PDFTextField.of(acro, ref, doc);
      f.getText = () => text;
      f.updateAppearances(font());
    };
    return { draw, stored };
  }

  if (type === key('Ch')) {
    const values = (value instanceof PDFArray ? value.asArray() : [value])
      .map((v) => textOf(v instanceof PDFRef ? doc.context.lookup(v) : v))
      .filter((v): v is string => !!v?.trim())
      .map((v) => shownAs(v, inherited(dict, 'Opt')));
    if (values.length === 0 || !sized(widget)) return null;
    const draw = () => {
      if (flags & COMBO) {
        const acro = PDFAcroComboBox.fromDict(field, ref);
        acro.getWidgets = () => [widget];
        const f = PDFDropdown.of(acro, ref, doc);
        f.getSelected = () => values;
        f.updateAppearances(font());
      } else {
        const acro = PDFAcroListBox.fromDict(field, ref);
        acro.getWidgets = () => [widget];
        const f = PDFOptionList.of(acro, ref, doc);
        f.getSelected = () => values;
        f.updateAppearances(font());
      }
    };
    return { draw, stored };
  }

  return type === key('Sig') || stored ? null : 'unread';
}

/** The stream, or the states' streams, readers draw; null when none. */
function normalAppearance(widget: PDFDict): PDFStream | PDFDict | null {
  const ap = widget.lookup(key('AP'));
  const n = ap instanceof PDFDict ? ap.lookup(key('N')) : undefined;
  if (n instanceof PDFStream) return n;
  return n instanceof PDFDict &&
    n.keys().some((k) => n.lookup(k) instanceof PDFStream)
    ? n
    : null;
}

/** Nothing shows in a widget without an area; pdf-lib needs it upright. */
function sized(widget: PDFWidgetAnnotation): boolean {
  const { x, y, width, height } = widget.getRectangle();
  if (!width || !height) return false;
  if (width < 0 || height < 0)
    widget.setRectangle({
      x: Math.min(x, x + width),
      y: Math.min(y, y + height),
      width: Math.abs(width),
      height: Math.abs(height),
    });
  return true;
}

function inherited(widget: PDFDict, name: string): PDFObject | undefined {
  const seen = new Set<PDFObject>();
  let node: PDFObject | undefined = widget;
  while (node instanceof PDFDict && !seen.has(node)) {
    seen.add(node);
    const found = node.lookup(key(name));
    if (found) return found;
    node = node.lookup(key('Parent'));
  }
  return undefined;
}

function textOf(value: PDFObject | undefined): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString)
    return value.decodeText();
  // Long text may be a stream; pdf-lib reads that as no value.
  if (value instanceof PDFRawStream)
    return PDFHexString.of(
      Buffer.from(decodePDFRawStream(value).decode()).toString('hex')
    ).decodeText();
  return null;
}

/** An option may be an `[export, display]` pair: readers show the display. */
function shownAs(value: string, options: PDFObject | undefined): string {
  if (options instanceof PDFArray)
    for (let i = 0; i < options.size(); i++) {
      const o = options.lookup(i);
      if (o instanceof PDFArray && textOf(o.lookup(0)) === value)
        return textOf(o.lookup(1)) ?? value;
    }
  return value;
}
