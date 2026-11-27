# Backup e recuperação — Doctor Tech Shop

Não guardar dumps, tokens ou dados pessoais no GitHub. Em estação confiável com PostgreSQL client instalado, configurar DATABASE_URL via ambiente local seguro (não registrar em histórico). Executar `pg_dump --format=custom --no-owner --no-acl --file=doctor-tech.dump "$DATABASE_URL"` e verificar com `pg_restore --list doctor-tech.dump`. Armazenar cópia criptografada fora do Render, com acesso restrito. Testar restauração somente em banco isolado e autorizado: `pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" doctor-tech.dump`. Nunca restaurar sobre produção sem plano e aprovação. Definir retenção e frequência conforme LGPD; sugerido diário e antes de migrações. A existência deste procedimento não comprova backup executado.

Monitoramento: Render /health, logs de falha, status de deploy e chamado WCS-60379. Não registrar credenciais nem dados de clientes em logs. Manter MP_COMMERCIAL_ENABLED=false até homologação.
