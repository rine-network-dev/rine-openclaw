#!/usr/bin/env bash
# Sourced by e2e-onboard.sh: the check that a transcript never carries the recovery phrase.

# A leak is any LEAK_RUN phrase words in phrase order, with anything between them that is not a
# letter (numbering, bullets, line breaks, case), so a model that re-types the words on separate
# lines is caught where a contiguous-string match would pass it.
LEAK_RUN=4
leaks_phrase_words() {
    awk -v run="$LEAK_RUN" '
        function words(text, out,   n, i, k, parts) {
            n = split(tolower(text), parts, /[^a-z]+/); k = 0
            for (i = 1; i <= n; i++) if (parts[i] != "") out[++k] = parts[i]
            return k
        }
        FNR == NR { phrase = phrase " " $0; next }
        { output = output " " $0 }
        END {
            p = words(phrase, pw); o = words(output, ow)
            for (i = 1; i <= o; i++) for (j = 1; j <= p; j++) {
                for (m = 0; i + m <= o && j + m <= p && ow[i + m] == pw[j + m]; m++) ;
                if (m >= run) exit 0
            }
            exit 1
        }' "$1" -
}
