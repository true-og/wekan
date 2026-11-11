"""Prints a mongo tools config line for MONGO_URL without its database path, so mongodump and mongorestore work on
named databases; authSource keeps the URI's database (the default it implied), so authentication is unchanged."""
import json, os, urllib.parse
u = urllib.parse.urlsplit(os.environ["MONGO_URL"])
q = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
db = u.path.lstrip("/")
if db and not any(k.lower() == "authsource" for k, _ in q):
    q.append(("authSource", db))
print("uri: " + json.dumps(urllib.parse.urlunsplit((u.scheme, u.netloc, "/", urllib.parse.urlencode(q), u.fragment))))
