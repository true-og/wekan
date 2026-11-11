"""TrueOG patches for WeKan 13.06's compiled server code (bundle/programs/server/app/app.js). Each patch is applied
once (marker), only if its anchor is found exactly once; app.js.orig-13.06 keeps the original.

setBoardTeams: before members are reconciled, add every user of an active team assigned to the board, since a
board admin who is not a site admin cannot see other users' teams in the browser. Same change as
server/models/boards.js in trueog/wekan.

oidcSignup (2026-11-11, operator: "staff-auth sign ups only, disable password registration"): with registration
disabled, Users.after.insert demanded an invitation code for every new OAuth2 account, so a first Staff-Auth
sign-in created the account and then failed ("error-invitation-code-not-exist"). Accounts created by the OIDC
service (services.oidc, set only by WeKan's server-side OIDC login) skip that check; Staff-Auth decides who gets
in. Password registration stays closed. Same change as server/models/users.js in trueog/wekan."""
import pathlib, shutil, sys
p = pathlib.Path(sys.argv[1])
orig = p.with_name("app.js.orig-13.06")
PATCHES = [
    ("setBoardTeams",
     "let l=e.filter(e=>e.isActive).map(e=>e.teamId),d=t.map(e=>e.userId).filter(e=>!n.members.some(t=>t&&t.userId===e)),c=new Map",
     "/*trueog-setBoardTeams*/"
     "{let r=e.filter(e=>!1!==e.isActive).map(e=>e.teamId);if(r.length>0)for(let s of await v.Meteor.users.find("
     '{"teams.teamId":{$in:r}},{fields:{_id:1}}).fetchAsync())t.some(e=>e.userId===s._id)||t.push({userId:s._id,'
     "isAdmin:!1,isActive:!0,isNoComments:!1,isCommentOnly:!1,isWorker:!1})}",
     "before"),
    ("oidcSignup",
     'if("ldap"!==t.authenticationMethod&&r){let e=null;if("string"==typeof t.authenticationMethod&&"oauth2"===',
     'if("ldap"!==t.authenticationMethod&&r&&!/*trueog-oidcSignup*/(t.services&&t.services.oidc)){let e=null;'
     'if("string"==typeof t.authenticationMethod&&"oauth2"===',
     "replace"),
]
s = p.read_text()
changed = []
for name, anchor, text, how in PATCHES:
    marker = f"/*trueog-{name}*/"
    if marker in s:
        want = text + anchor if how == "before" else text
        if s.count(marker) == 1 and s.count(want) == 1:
            print(f"{name}: already patched")
            continue
        sys.exit(f"{name}: app.js has the marker but not exactly the reviewed patch; nothing written")
    if s.count(anchor) != 1:
        sys.exit(f"{name}: anchor found {s.count(anchor)} times, expected 1; nothing written")
    s = s.replace(anchor, text + anchor if how == "before" else text)
    changed.append(name)
if not changed:
    print("app.js already has every patch")
    sys.exit(0)
if not orig.exists():
    shutil.copy2(p, orig)
p.chmod(0o644)
p.write_text(s)
p.chmod(0o444)
print("app.js patched (" + ", ".join(changed) + "), original kept as " + orig.name)
