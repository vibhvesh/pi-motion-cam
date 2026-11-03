"""Classic behaviour: motion (+ optional person required) -> snapshot alert, with cooldown handled by the event bus."""
from .base import Module, Event, PERSON


class MotionAlertModule(Module):
    name = "motion_alert"

    def __init__(self, cfg, ctx):
        super().__init__(cfg, ctx)
        self.require_person = cfg.get("require_person", True)

    def process(self, f):
        if not self.active() or not f.motion_area or f.motion_area < self.ctx.min_motion_area:
            return []
        people = [t for t in f.tracks.values() if t.cls == PERSON]
        if self.require_person and not people:
            return []
        self.count("alerts")
        return [Event(self.name, "motion", f"Motion detected — people: {len(people)}", "info")]
