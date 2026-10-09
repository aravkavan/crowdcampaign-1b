"""CrowdCampaign market-intel tracker (Assignment 1B).

An agent that researches each campaign listed in config.yaml, ranks the top K recent
developments with sources, and on every later run reports what is new since last time.
Its memory lives in the CrowdCampaign database, reached only through the app's API.

    python -m tracker run         research and save one run
    python -m tracker.tools ...   run one tool on its own (see tools.py)
"""
__version__ = "1.0.0"
