# Canopy

A shared map of partnerships between The Nature Conservancy and the Forest Service. Each entry is one TNC person, one USFS person, the forest or branch, and a short purpose. The map and a word cloud of those purpose words update as people add pairs.

There is no sign-in. Anyone who can open a running copy can add and remove partnerships. This is for testing and development.

## Run it

```bash
./run.sh
```

Then open http://127.0.0.1:8741

The first run creates a virtual environment and installs Flask. Colleagues on the same network can use this computer's address on port 8741.

## Where the map lives

Names, forests, and purposes are stored in `data/canopy.db` on the computer that is running Canopy. That file is not part of this repository. Cloning the project gives you the app, and an empty map until someone fills it in on that copy.

GitHub holds the code so it can be tried and changed. It does not hold the partnership list.
