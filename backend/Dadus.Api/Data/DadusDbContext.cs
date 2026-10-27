using Microsoft.EntityFrameworkCore;

namespace Dadus.Api.Data;

public sealed class DadusDbContext(DbContextOptions<DadusDbContext> options) : DbContext(options)
{
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<ChatMessage> Messages => Set<ChatMessage>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var conversation = modelBuilder.Entity<Conversation>();
        conversation.HasKey(x => x.Id);
        conversation.Property(x => x.Title).HasMaxLength(80);
        conversation.Property(x => x.UpdatedAt)
            .HasConversion(x => x, x => DateTime.SpecifyKind(x, DateTimeKind.Utc));
        conversation.HasIndex(x => new { x.OwnerSessionId, x.UpdatedAt });

        var message = modelBuilder.Entity<ChatMessage>();
        message.HasKey(x => x.Id);
        message.Property(x => x.Role).HasMaxLength(16);
        message.Property(x => x.Content).HasMaxLength(12000);
        message.Property(x => x.CreatedAt)
            .HasConversion(x => x, x => DateTime.SpecifyKind(x, DateTimeKind.Utc));
        message.HasIndex(x => new { x.ConversationId, x.CreatedAt }).IsUnique();
        message.HasOne(x => x.Conversation).WithMany(x => x.Messages)
            .HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class Conversation
{
    public Guid Id { get; set; }
    public Guid OwnerSessionId { get; set; }
    public string Title { get; set; } = "";
    public DateTime UpdatedAt { get; set; }
    public List<ChatMessage> Messages { get; set; } = [];
}

public sealed class ChatMessage
{
    public Guid Id { get; set; }
    public Guid ConversationId { get; set; }
    public Conversation Conversation { get; set; } = null!;
    public string Role { get; set; } = "";
    public string Content { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
