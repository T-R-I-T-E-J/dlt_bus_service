-- Runs only when this dedicated PostgreSQL volume is initialized from empty.
-- Read the generated application password without placing it in SQL source.
\getenv dlt_app_password DLT_APP_PASSWORD
CREATE ROLE dlt_app LOGIN PASSWORD :'dlt_app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
