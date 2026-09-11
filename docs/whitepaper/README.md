# The whitepaper, and how it is rebuilt

`nonametrust-whitepaper.tr.md` and `nonametrust-whitepaper.en.md` are the
editable sources of the NonameTrust whitepaper, in Turkish and English. The two
are companion texts in their own registers, not translations of each other;
an edit to a claim is made in both.

## Where this came from

The whitepaper was first produced on 23 August 2026 as two PDFs by a ReportLab
script that no longer exists anywhere. The Markdown here was reconstructed from
those PDFs on 12 September 2026: the text was extracted and re-flowed paragraph
by paragraph, the tables were rebuilt, and the seven figures were cut out of the
PDFs' own vector content as SVG (`figures/`). The figures are therefore faithful
but not editable: their text is glyph outlines. Figures 5 to 7 can be regenerated from the published
study data in `github.com/KayaKerem/nonametrust` when someone writes that
generator; Figures 1 to 4 are diagrams and would be redrawn by hand.

## Building the PDFs

```bash
python3 docs/whitepaper/build.py        # both languages
python3 docs/whitepaper/build.py en     # one
```

Output is `docs/whitepaper/build/nonametrust-whitepaper.{tr,en}.pdf`, which
is not tracked. The pipeline is pandoc 3 (Markdown to HTML through
`template.html` and `style.css`) and headless Google Chrome (HTML to PDF).
Nothing is downloaded at build time: the fonts are in `fonts/`, subsets of
DejaVu Serif, Sans and Sans Mono (the faces the original PDFs embedded) covering
Latin, Turkish, Greek, combining marks, punctuation, sub- and superscripts and
mathematical operators, under the licence in `fonts/LICENSE`. A character
outside those ranges will fall back to a system font; regenerate the subsets
from the full DejaVu 2.37 files with `pyftsubset` if that happens.

If Chrome is somewhere unusual, `CHROME=/path/to/binary python3 build.py`.

## Writing conventions the sources rely on

- Section numbers are written into the headings by hand, as the original did.
- Tables are pipe tables with a `Table:` caption line; figures are a single
  image paragraph whose alt text is the caption. Both render with the caption
  below.
- Body text carries no inline emphasis; the original had none. Bold is used
  only for the lead-in of each design bullet in Section 4.
- Straight quotes and hyphens are kept as they are: the build disables pandoc's
  smart punctuation and dollar math.
- The front matter's `pagelabel` is the word in the page footer.

## Publishing

The landing site serves its own copy of the English PDF at
`nonametrust-landing/public/nonametrust-whitepaper-en.pdf`. That copy is not
updated by this build; replacing it is a deliberate, separate step.
