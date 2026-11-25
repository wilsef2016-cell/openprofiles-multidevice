# MultiDevice v0.8 · OpenProfiles — Meu perfil

## Configurar

1. No OpenProfiles, abra **Aparelhos e perfis → Configurar OpenProfiles — Meu perfil** e autorize separadamente cada perfil que pode aparecer no catálogo dinâmico.
2. Em cada navegador pareado, selecione o perfil, confirme o vínculo na **Associação de rede** e autorize o vínculo atual na página **Meu perfil**. Uma ligação renovada precisa de nova autorização.
3. Gere um único link privado para a conta e instale-o no Stremio. O manifesto apresenta **Meu perfil — Filmes** e **Meu perfil — Séries**. O link é mostrado só ao ser gerado.

A instalação é sincronizada pela conta Stremio. Revogar um perfil ou aparelho restringe as consultas futuras sem apagar o progresso. Revogar ou substituir o link desabilita a chave anterior. Os catálogos fixos da v0.7 continuam disponíveis de forma independente. [Instalação de add-ons por conta](https://stremio.zendesk.com/hc/en-us/articles/360021348391-How-to-install-uninstall-Add-ons)

## Como a rede é usada

O token autentica o acesso experimental de leitura da conta OpenProfiles. O servidor usa o vínculo por rede para escolher um aparelho provável, com autorização explícita daquele vínculo e do perfil selecionado. Quando há zero ou mais de um vínculo ativo na conta para o endereço observado, a lista vem vazia. O mesmo acontece quando o único candidato está expirado, revogado, sem consentimento vigente ou associado a um perfil indisponível ou sem autorização. Um segundo vínculo válido conta como ambiguidade mesmo sem autorizar o catálogo.

O experimento usa o endereço da conexão ou o IP calculado pelo Express atrás dos proxies confiados por endereço. Configurações que confiam em qualquer proxy ou apenas na quantidade de saltos usam o endereço da conexão. O cabeçalho `X-Real-IP` que a ponte pode usar no diagnóstico legado não serve para selecionar um perfil. Um proxy autorizado pelo servidor precisa substituir ou sanitizar os cabeçalhos de encaminhamento. Se o IP visto na solicitação do Stremio diferir do IP do vínculo, a correspondência pode falhar e o catálogo ficar vazio. [Express atrás de proxies](https://expressjs.com/en/guide/behind-proxies.html)

O protocolo `catalog` não informa a identidade do navegador pareado. Uma conexão compartilhada, VPN, NAT ou proxy pode parecer o único aparelho conhecido, especialmente se outro aparelho da rede estiver sem vínculo ativo. Quem tem acesso ao link sincronizado e compartilha esse endereço pode receber o mesmo catálogo. Este modo serve para experimentos de seleção e não garante privacidade entre aparelhos ou perfis numa conta compartilhada. [Protocolo de add-ons do Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)

## Cache e abertura dos títulos

O servidor marca o manifesto, as listas e as capas como `private, no-store`, usa `Vary: *` e evita respostas condicionais `304`. Cada URL de capa inclui um contexto opaco do aparelho, do perfil e das autorizações. O servidor confere novamente a seleção e as permissões após buscar metadados ou capas. Os metadados e as imagens públicas mantêm o cache interno da v0.7. As listas privadas de progresso são recalculadas a cada solicitação.

O código do Stremio Core pode reutilizar uma página de catálogo já carregada quando a solicitação permanece igual. Como o link e os IDs das listas são os mesmos em todos os aparelhos, o servidor não consegue forçar o cliente a pedir outra lista nem remover o que um cliente ou intermediário já guardou. Uma troca de perfil ou revogação pode ficar invisível até uma nova consulta. Ainda é preciso medir isso por plataforma, inclusive ao trocar de rede com a tela aberta. [Reutilização de catálogos no Stremio Core](https://github.com/Stremio/stremio-core/blob/d3e05c2a5f6680651836125152e10eb90ae8f8e2/src/models/catalogs_with_extra.rs#L255-L301) · [RFC 9111 sobre cache HTTP](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5)

O catálogo lê `mp_native_history_events` e reaproveita títulos, capas, agrupamento de episódios e IDs canônicos da v0.7. Os detalhes e a reprodução são fornecidos pelos add-ons habituais do Stremio. O progresso exibido é informativo, e a biblioteca, o histórico e o **Continuar assistindo** nativos ficam fora desse fluxo.

## Validação

Os testes HTTP cobrem dois aparelhos e um único link em redes distintas, candidatos no mesmo IP, troca de perfil durante e entre solicitações, expiração, revogação, encaminhamento sem fonte confiável e contas distintas na mesma rede. Também verificam que capas de um contexto são recusadas em outro e que os catálogos da v0.7 permanecem disponíveis.

A instalação real, a origem que cada aplicativo apresenta ao servidor, a renderização, a abertura de filmes e séries e o tempo de renovação da lista ainda dependem de testes no Stremio Web, desktop, celular e TV. Use perfis de teste para avaliar especialmente endereços compartilhados e conteúdo já carregado.
