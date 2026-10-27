import tempfile
from pathlib import Path

import calibrate as c

c.ELO_CHECKPOINTS = [1600]
c.GAMES_PER_CHECKPOINT = 2
c.MAX_PLIES = 60
# a file of its own: results.jsonl is the record of the full study, and a smoke run must not replace it
c.RESULTS_PATH = Path(tempfile.gettempdir()) / "calibration_smoke_results.jsonl"

c.main()
