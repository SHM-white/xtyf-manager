"""Dimensions and layout regression for vector asset label PDFs."""
from io import BytesIO
import pytest

from modules.asset_labels import label_geometry, build_labels_pdf
from modules.assets import Invalid


@pytest.mark.parametrize("width,height,mode", [
    (50, 30, "wide"), (30, 30, "compact"), (25, 15, "compact"), (20, 12, "compact")
])
def test_auto_layout_stays_inside_printable_label(width, height, mode):
    g = label_geometry(width, height)
    assert g["mode"] == mode
    for x, y, w, h in (g["text"], g["qr"], g["barcode"]):
        assert min(x, y) >= 0
        assert w > 0 and h > 0
        assert x + w <= width + 1e-6
        assert y + h <= height + 1e-6
    assert g["qr"][2] == g["qr"][3]


def test_manual_layout_and_invalid_dimensions():
    assert label_geometry(50, 30, "compact")["mode"] == "compact"
    assert label_geometry(30, 30, "wide")["mode"] == "wide"
    with pytest.raises(Invalid):
        label_geometry(14, 10)
    with pytest.raises(Invalid):
        label_geometry(50, 9)
    with pytest.raises(Invalid):
        label_geometry(50, 30, "none")


def test_vector_pdf_preserves_exact_page_size_and_a4_grid():
    import pdfplumber

    entries = [("M:128", "贴片电阻 10kΩ", "0603")] * 5
    for w, h, layout in [(50, 30, "wide"), (30, 30, "compact"), (20, 12, "auto")]:
        output = build_labels_pdf(entries[:1], w, h, "thermal", layout, 12, 82)
        with pdfplumber.open(BytesIO(output.getvalue())) as pdf:
            assert len(pdf.pages) == 1
            assert abs(pdf.pages[0].width * 25.4 / 72 - w) < .02
            assert abs(pdf.pages[0].height * 25.4 / 72 - h) < .02

    output = build_labels_pdf(entries, 50, 30, "a4", "auto", 11, 88)
    with pdfplumber.open(BytesIO(output.getvalue())) as pdf:
        assert len(pdf.pages) == 1
        assert abs(pdf.pages[0].width * 25.4 / 72 - 210) < .02
        assert abs(pdf.pages[0].height * 25.4 / 72 - 297) < .02


def test_rejects_out_of_range_font_and_paper():
    data = [("U:42", "M3508 电机", "SN-1")]
    with pytest.raises(Invalid):
        build_labels_pdf(data, 50, 30, font=19)
    with pytest.raises(Invalid):
        build_labels_pdf(data, 50, 30, font_width=60)
    with pytest.raises(Invalid):
        build_labels_pdf(data, 50, 30, paper="unknown")
