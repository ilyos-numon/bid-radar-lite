-- Intentionally empty. Test users and workspaces are created by tests through the Auth admin API.

-- LOCAL DEVELOPMENT ONLY: login password for the app role.
-- Cloud projects set their own password; never reuse this value outside the local stack.
alter role app_worker login password 'app_worker';
