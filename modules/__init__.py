"""Pi Motion Cam smart modules. Each is enabled in config.yaml under `modules:`."""
import logging

from .attendance import AttendanceModule
from .behavior import FallModule, FightModule
from .counter import CounterModule
from .motion_alert import MotionAlertModule
from .scene import FireSmokeModule, TamperModule
from .zones import AfterHoursModule, AnimalModule, LoiteringModule, OccupancyModule, PerimeterModule, ZoneIntrusionModule

log = logging.getLogger("motioncam")
REGISTRY = {m.name: m for m in [MotionAlertModule, AttendanceModule, CounterModule, ZoneIntrusionModule, FallModule,
                                FightModule, PerimeterModule, LoiteringModule, OccupancyModule, AnimalModule,
                                TamperModule, FireSmokeModule, AfterHoursModule]}


def load_modules(mod_cfg, ctx):
    out = []
    for name, cls in REGISTRY.items():
        c = (mod_cfg or {}).get(name) or {}
        if not c.get("enabled", False):
            continue
        try:
            out.append(cls(c, ctx))
            log.info("Module enabled: %s", name)
        except ImportError as e:
            log.error("Module %s needs an optional package: %s", name, e)
        except Exception as e:
            log.exception("Module %s failed to start: %s", name, e)
    return out
