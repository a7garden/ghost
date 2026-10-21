CREATE TABLE IF NOT EXISTS lifetime_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    authority_epoch INTEGER NOT NULL CHECK (authority_epoch BETWEEN 1 AND 9007199254740991),
    dispatch_enabled INTEGER NOT NULL CHECK (dispatch_enabled IN (0, 1))
);
INSERT OR IGNORE INTO lifetime_authority(singleton, authority_epoch, dispatch_enabled)
VALUES (1, 1, 1);
