from oortmem import Oort
from oortmem.types import NearQuery, Place, Pose

# A robot's memory of a site: each fact is remembered with where it was seen. Places are kept by
# the local engine (0.9.0 or newer); Oort Cloud refuses them until it holds places too.
with Oort(mode="local") as oort:
    seen = [
        ("The red toolbox is on shelf A1.", Place(node_id="site:hq/room:A/shelf:A1", map_id="hq", pose=Pose(x=1, y=1))),
        ("The blue toolbox is on shelf B3.", Place(node_id="site:hq/room:B/shelf:B3", map_id="hq", pose=Pose(x=11, y=1))),
        ("The green toolbox sits under the window.", Place(node_id="site:hq/room:B", map_id="hq", pose=Pose(x=13, y=4))),
    ]
    for fact, place in seen:
        oort.remember(fact, place=place)

    # Which toolboxes are in room B? `within` matches whole path segments: room:B, never room:B2.
    for m in oort.recall("toolbox", within="room:B").memories:
        print(m.why.place_path, "|", m.text)

    # What is within 1.5 m of the robot? Distance is measured on the same map and frame only.
    here = NearQuery(map_id="hq", pose=Pose(x=13, y=3), radius=1.5)
    for m in oort.recall("toolbox", near=here).memories:
        print(f"{m.why.distance_m:.2f}", "|", m.text)
