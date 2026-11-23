"""Prepares reply text for Supertonic: it reads digits, separators and links poorly, so they become words."""
import re

_SINO = "영일이삼사오육칠팔구"
_SMALL = ["", "십", "백", "천"]
_BIG = ["", "만", "억", "조"]
_NATIVE_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"]
_NATIVE_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"]
# Counters read with native numbers (up to 99); everything else uses sino-Korean.
_NATIVE_COUNTERS = ("시간", "시", "개", "명", "살", "마리", "잔", "권", "병", "대", "장", "그릇", "번째", "번", "곳", "분께", "가지", "송이")
_SYMBOLS = {"%": "퍼센트", "℃": "도", "°C": "도", "원": "원", "$": "달러", "₩": "원"}
_UNIT = r"(?:%|℃|°C|[가-힣]{1,3})"


def sino(n: int) -> str:
    if n == 0:
        return "영"
    groups, out = [], []
    while n:
        groups.append(n % 10000)
        n //= 10000
    for index in range(len(groups) - 1, -1, -1):
        value = groups[index]
        if not value:
            continue
        text = ""
        for position in range(3, -1, -1):
            digit = value // 10**position % 10
            if digit:
                text += ("" if digit == 1 and position > 0 else _SINO[digit]) + _SMALL[position]
        out.append(_BIG[index] if value == 1 and index == 1 else text + _BIG[index])
    return "".join(out)


def native(n: int) -> str:
    if not 1 <= n <= 99:
        return sino(n)
    tens, ones = divmod(n, 10)
    if n == 20:
        return "스무"
    return _NATIVE_TENS[tens] + _NATIVE_ONES[ones]


def _number(text: str, counter: str) -> str:
    digits = text.replace(",", "")
    if "." in digits:
        whole, fraction = digits.split(".", 1)
        return sino(int(whole)) + " 점 " + " ".join(_SINO[int(c)] for c in fraction)
    value = int(digits)
    if counter.startswith(_NATIVE_COUNTERS) and 1 <= value <= 99:
        return native(value)
    return sino(value)


def normalize(text: str) -> str:
    text = re.sub(r"https?://\S+|www\.\S+", "링크", text)
    text = re.sub(r"[`*_#>|~]+", " ", text)
    text = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF]", "", text)

    def replace(match):
        number, unit = match.group(1), match.group(2) or ""
        spoken = _number(number, unit)
        return spoken + _SYMBOLS.get(unit, unit)

    text = re.sub(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?(" + _UNIT + r"))?", replace, text)
    return re.sub(r"[ \t]+", " ", text).strip()
