# MultiDevice v0.7 · Catálogo de histórico experimental

## Autorizar e instalar

1. Entre no OpenProfiles e abra **Aparelhos e perfis → Histórico experimental do Stremio**. Selecione o perfil e abra **Autorizar catálogo no Stremio**.
2. Confira o perfil e aceite o consentimento. Use **Instalar no Stremio** ou copie o link HTTPS do manifesto para a instalação manual. O link aparece somente quando é gerado.
3. Procure as listas de filmes e séries com o nome **OpenProfiles — Nome do perfil**. Para autorizar outro perfil, gere um link próprio.

A instalação do add-on é sincronizada pela conta Stremio. Os catálogos autorizados podem aparecer em outros aparelhos dessa conta. Quem possui o link consegue ler o progresso experimental do perfil, mesmo fora do navegador pareado. **Revogar link** ou gerar outro link impede novas consultas com a chave antiga. A revogação não apaga itens que o cliente já armazenou em cache. Perfis na lixeira ou protegidos por PIN ficam indisponíveis. [Instalação de add-ons por conta](https://stremio.zendesk.com/hc/en-us/articles/360021348391-How-to-install-uninstall-Add-ons)

## Dados exibidos

O catálogo consulta `mp_native_history_events` em modo de leitura e desconsidera atribuições desfeitas. Para cada vídeo, mostra a maior posição registrada e a duração do evento correspondente. Para séries IMDb, TMDB e Kitsu em formatos reconhecidos, agrupa os episódios pelo ID da série e exibe o progresso do episódio com atividade mais recente. Os demais IDs são mantidos exatamente como chegaram.

Os títulos e as capas IMDb são obtidos da Cinemeta e do MetaHub. Somente o ID público do título é solicitado ao provedor. Quando o título não tem metadados válidos ou o provedor demora a responder, o catálogo exibe o ID e a posição. Uma capa ausente, inválida ou indisponível é substituída por uma imagem neutra. IDs de outros provedores mantêm o rótulo com o ID e o progresso. [Cinemeta e IDs canônicos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md)

Cada item usa o tipo e o ID que os add-ons de metadados e de streaming já conhecem. O catálogo declara somente o recurso `catalog`. Abrir um item usa os detalhes e streams dos add-ons instalados que atendam àquele ID. A posição exibida é informativa. O catálogo não altera o **Continuar assistindo**, a biblioteca, a lista de add-ons compartilhados nem a posição aplicada pelo player. [Protocolo oficial de add-ons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)

## Validação

Os testes HTTP cobrem manifesto, filmes e séries de dois perfis, agrupamento de episódios, paginação, capas, falhas de metadados, autorização, revogação, rotação e isolamento entre contas. O SQLite recebe somente uma tabela adicional de concessões, com hashes separados dos tokens do Tracking Addon. O seletor e o histórico experimental da v0.6 seguem disponíveis.

Ainda é preciso validar nos clientes oficiais a instalação pelo link, a aparência das linhas e das informações de progresso, a abertura dos detalhes e o tempo de atualização após revogar uma chave. A apresentação pode variar entre Stremio Web, desktop, celular e TV.
